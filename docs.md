# «Диспетчерская» — live-операционка для локальной доставки

Техническое задание на бэкенд. Стек, доменная модель, realtime-контракт, этапы.
Макет интерфейса: `mockup.html` (открыть в браузере) — там же подписано, какое событие питает какой блок.

---

## 1. Что строим и для кого

**Пользователи и их клиенты (три разных фронта, три разных сокет-соединения):**

| Роль | Клиент | Что делает |
|---|---|---|
| Диспетчер | Веб-панель (десктоп) | Видит все заказы, курьеров на карте, назначает, пишет в чат, следит за SLA |
| Курьер | Устанавливаемая PWA (позже — Capacitor, см. 6.1) | Принимает заказ, шлёт геопозицию, меняет статус, фото доставки, чат |
| Клиент | Публичная ссылка без логина | Видит статус своего заказа и курьера на карте, пишет в чат |

Масштаб одного тенанта: 5–50 заказов/день, 3–10 курьеров, 1–2 диспетчера. Продукт мультиарендный (SaaS), поэтому реальная нагрузка = сумма по всем тенантам.

**Почему многоинстансовость здесь неизбежна, а не выдумана.** Диспетчер назначил заказ — курьер и клиент должны увидеть это мгновенно, но они висят на **разных инстансах** приложения. `server.emit()` из in-memory socket.io долетит только до тех, кто подключён к тому же процессу. Плюс: при деплое инстансы перезапускаются по очереди, все сокеты рвутся и переподключаются на другой процесс — состояние обязано доехать целым.

Честно: на 10 курьерах нагрузки нет. Многоинстансовость нужна для **zero-downtime деплоя, отказоустойчивости и мультиарендности**, а не ради RPS. Но архитектурно это ровно та же задача.

---

## 2. Архитектура

```
                       ┌──────────────┐
   диспетчер (web) ────┤              │
   курьер (PWA/TG) ────┤  Nginx / LB  │   sticky session по ip_hash
   клиент (link)   ────┤              │
                       └──────┬───────┘
                  ┌───────────┼───────────┐
             ┌────┴───┐  ┌────┴───┐  ┌────┴───┐
             │ Nest #1│  │ Nest #2│  │ Nest #N│   ← stateless
             └────┬───┘  └────┬───┘  └────┬───┘
                  └───────────┼───────────┘
              ┌───────────────┼────────────────┐
        ┌─────┴─────┐   ┌─────┴─────┐   ┌──────┴──────┐
        │  Redis    │   │ Postgres  │   │   MinIO/S3  │
        │ adapter   │   │ +PostGIS  │   │  фото, подпись│
        │ pub/sub   │   │ event_log │   └─────────────┘
        │ GEO, lock │   │ outbox    │
        │ BullMQ    │   └───────────┘
        └───────────┘
                  │
            ┌─────┴──────┐
            │  Worker    │  таймеры SLA, пуши, ETA, дайджесты
            └────────────┘
```

Инстансы приложения не хранят состояния. Всё, что переживает реконнект, лежит в Postgres; всё, что должно долететь до других процессов, идёт через Redis.

---

## 3. Стек и обоснование выбора

### 3.1 Транспорт realtime — Socket.IO + `@socket.io/redis-adapter`

**Почему Socket.IO, а не голый `ws`:** нужны комнаты (`order:42`, `tenant:7`), acknowledgements (курьер должен знать, что «доставлено» реально записалось), авто-reconnect с backoff, fallback на long-polling в метро у курьера, и — главное — **готовый Redis-адаптер**. На голом `ws` всё это пишется руками неделю.

**Почему не SSE:** односторонний. Курьер шлёт координаты, клиент пишет в чат — нужен дуплекс.

**Почему не Centrifugo/Soketi:** отдельный сервис, свой протокол, бизнес-логика всё равно остаётся в Nest и общается с ним через HTTP-API. Оправдано с 10k+ соединений; у нас это лишний слой.

```ts
// main.ts — без этого multi-instance не работает
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
app.useWebSocketAdapter(new RedisIoAdapter(app, pubClient, subClient));
```

С адаптером `server.to('order:42').emit(...)` уходит в Redis pub/sub, и **каждый** инстанс доставляет своим сокетам.

**Sticky sessions обязательны** (`ip_hash` в nginx), иначе polling-транзакт handshake ломается: первый запрос ушёл на инстанс 1, второй — на инстанс 2, который про сессию не знает.

### 3.2 Redis — 4 роли, не одна

1. **Adapter (pub/sub)** — межинстансная рассылка.
2. **GEO** — `GEOADD couriers:live` для «кто ближе к точке», последняя позиция курьера с TTL (горячее чтение без похода в Postgres).
3. **Locks / idempotency** — `SET lock:order:42 <owner> NX PX 5000`, чтобы два диспетчера одновременно не назначили заказ двум курьерам.
4. **BullMQ** — очереди и отложенные задачи.

### 3.3 Postgres + PostGIS (TypeORM уже подключён)

Реляционка нужна, потому что данные транзакционные: назначение заказа = смена статуса + запись в лог + запись в outbox **атомарно**. В Mongo это боль, в Postgres — одна транзакция.

**PostGIS** — для «найти курьеров в радиусе 3 км», расчёта пробега за смену, зон доставки (полигоны). Без него придётся считать haversine на приложении и потерять индексы.

Трек курьера — «горячая» таблица с высокой вставкой. Партиционировать по дню (нативный `PARTITION BY RANGE`), старые партиции дропать/архивировать. TimescaleDB — опция, когда тенантов станет много; на старте избыточна.

### 3.4 BullMQ (очереди)

- SLA-таймеры: заказ 10 минут без курьера → эскалация диспетчеру.
- Отложенные пуши: «курьер не двигается 15 минут».
- Пересчёт ETA раз в 30 сек для активных заказов.
- Отправка уведомлений с ретраями (web-push/SMS падают — задача переедет).

Почему не `setTimeout` в процессе: инстанс перезапустится при деплое — таймер потеряется. BullMQ хранит их в Redis.

### 3.5 Карты и ETA

- Фронт: **MapLibre GL JS** + тайлы OSM/MapTiler — бесплатно, без вендор-лока на Google.
- Геокодинг адреса (адрес → координаты): Nominatim или Photon (self-host, данные OSM по Украине хорошие), для сложных адресов — Visicom (украинский провайдер, точнее OSM по частному сектору) либо Google Geocoding. Кешировать результат в таблице `addresses` — адреса повторяются.
- ETA/маршрут: MVP — haversine × 1.4 × средняя скорость. Далее — **self-hosted OSRM** (докер, бесплатно, ~100мс на запрос) или Mapbox Directions.

### 3.6 Аутентификация

- Диспетчер/курьер: JWT access (15 мин) + refresh в httpOnly cookie (`cookie-parser` уже стоит). Access-токен передаётся в WS-хендшейке: `io(url, { auth: { token } })`, проверяется в `handleConnection`.
- **Клиент — без логина**: у заказа есть `public_token` (opaque, 32 байта). Ссылка `/t/<token>`. Токен даёт доступ только к комнате `public:track:<token>`, отдаёт урезанный DTO (без телефона курьера, без цены закупки) и протухает через 2 часа после доставки.

### 3.7 Валидация — штатный `class-validator` + `ValidationPipe`

Родной механизм Nest, никаких альтернативных валидаторов. Работает и в контроллерах, и в гейтвеях:

```ts
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@SubscribeMessage('order.setStatus')
handle(@MessageBody() dto: SetStatusDto, @ConnectedSocket() socket: AuthSocket) {}
```

`whitelist` + `forbidNonWhitelisted` обязательны: в WS прилетает что угодно, и лишние поля должны отлетать, а не доезжать до репозитория.

**Почему не Zod.** Главный аргумент за штатный путь — **`@nestjs/swagger` генерит OpenAPI прямо из тех же DTO-классов**. Для продукта, который продаётся магазинам, готовая схема API — это половина разговора об интеграции («вот `/docs`, постите заказы сюда»). С Zod то же самое требует `nestjs-zod` и лишнего слоя.

Единственное, где Zod объективно сильнее — discriminated unions (payload, меняющий форму в зависимости от целевого статуса). Обходится дешевле: **отдельный DTO на переход** вместо одного универсального. Это и читается лучше, и стыкуется со стейт-машиной один к одному.

Валидация `.env` — тем же `class-validator` через `validate`-функцию в `ConfigModule.forRoot({ validate })`. Ноль новых зависимостей.

**Типы для фронта:** не выводим из валидатора, а генерим OpenAPI → `openapi-typescript`. Плюс общий пакет с типами WS-событий (обычные `interface`, без рантайма).

### 3.8 Клиент курьера — PWA (Telegram-бот в MVP не делаем)

Курьер работает в устанавливаемой PWA: тот же фронт, `manifest.json`, service worker, офлайн-очередь в IndexedDB. Отдельного мобильного приложения на старте нет.

Telegram-бот из спеки убран. Он выглядит дешёвым каналом, но приносит второй набор UI-состояний, вторую очередь ошибок доставки и соблазн продублировать в нём бизнес-логику — при том, что live-локацию Telegram отдаёт редко и только после ручного включения шаринга курьером. Когда он реально понадобится — см. 6.1.

Уведомления в MVP: Web Push (VAPID) для диспетчера и курьера, SMS клиенту при статусе «в пути» (опция тенанта).

### 3.9 Чем пишутся клиенты и почему не React Native

Мобильное приложение здесь **одно из трёх**, и это меняет расчёт:

| Клиент | Чем является | Устанавливается? |
|---|---|---|
| Диспетчер | Десктопный веб, три колонки, много данных на экране | нет |
| Клиент | Ссылка `/t/<token>` в браузере | нет, и не должен — установка убьёт конверсию |
| Курьер | Единственное, что живёт на телефоне | да |

Курьерский экран по содержанию — список заказов, одна кнопка статуса, карта, чат, камера для фото доставки. Никакой тяжёлой графики и сложных жестов. Это ровно то, что WebView тянет без вопросов.

| Вариант | Что это | Цена решения |
|---|---|---|
| **PWA** | Обычный веб + `manifest.json` + service worker, ставится на домашний экран | Бесплатно, деплоится как сайт. **Нет фоновой геолокации** — стоп-фактор (6.1) |
| **Capacitor** ✅ | Тот же веб-код в нативном контейнере + нативные плагины | ~неделя на упаковку, $99/год Apple, $25 разово Google. UI не переписывается |
| React Native | Отдельное приложение, TS, но свой UI-слой и своя экосистема | Второй фронтенд-кодбейс с нуля. Оправдан, если мобилка — основной продукт |
| Kotlin / Swift | Полностью нативно | **Два приложения**, два языка. Kotlin — только Android, для iOS нужен Swift |

**Выбор: Capacitor.** Веб-часть всё равно пишется — диспетчер и публичный трекинг без неё не существуют. Capacitor берёт этот же код и кладёт в нативную оболочку, где доступны фоновая геолокация, нативные пуши, камера и Wake Lock. React Native означает второй кодбейс, второй релизный цикл и вдвое больше мест, где чинить баг, — для соло-разработчика, которому нужно дойти до первых платящих клиентов, это неоправданно.

Порог, за которым RN/нативка станут оправданы: офлайн-карты, тяжёлая офлайн-синхронизация сотен заказов, постоянный сканер штрихкодов. При 5–50 заказах в день этого нет.

**Ключевое следствие для бэкенда.** Фоновый геоплагин (`@transistorsoft/capacitor-background-geolocation` или community-аналог) работает **вне JS-контекста**: приложение может быть свёрнуто или выгружено из памяти, а нативный сервис продолжает собирать точки и отправлять их сам — **обычным HTTP-POST-ом на URL из конфига, не через WebSocket**. Значит `POST /locations` — не опциональный дубль, а основной путь доставки геоданных в проде. WS-событие `location.push` остаётся для случая «приложение открыто и на экране».

Оба пути обязаны идти в один и тот же сервис с одной валидацией и одной дедупликацией по `(courier_id, ts)` — иначе получишь два расходящихся набора координат.

**И главное: бэкенду всё равно.** REST + Socket.IO одинаково работают из браузера, из Capacitor и из React Native (`socket.io-client` везде тот же). Решение про мобильный клиент не блокирует ни одну фазу бэкенда и может быть принято позже — при условии, что `POST /locations` заложен сразу.

---

## 4. Доменная модель

```sql
-- ── тенант и пользователи ─────────────────────────────────────────
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Europe/Kyiv',
  currency      char(3) NOT NULL DEFAULT 'UAH',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner','dispatcher','courier');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  role          user_role NOT NULL,
  name          text NOT NULL,
  email         text,
  login         text NOT NULL,
  password_hash text NOT NULL,          -- argon2id
  phone         text,
  avatar_url    text,
  push_subs     jsonb NOT NULL DEFAULT '[]',   -- Web Push endpoints (несколько устройств)
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, login)
);

-- профиль курьера (1:1 с users при role='courier')
CREATE TYPE transport_kind AS ENUM ('foot','bike','scooter','car');
CREATE TYPE courier_state AS ENUM ('offline','free','busy','break');

CREATE TABLE courier_profiles (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  transport        transport_kind NOT NULL,
  transport_number text,
  transport_color  text,
  state            courier_state NOT NULL DEFAULT 'offline',
  max_parallel     smallint NOT NULL DEFAULT 3,
  shift_started_at timestamptz
);

-- ── заказы ────────────────────────────────────────────────────────
CREATE TYPE order_status AS ENUM (
  'new','assigned','accepted','picked_up','en_route','delivered','canceled','failed'
);

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  number         integer NOT NULL,          -- человекочитаемый, per-tenant
  status         order_status NOT NULL DEFAULT 'new',
  courier_id     uuid REFERENCES users(id),

  client_name    text NOT NULL,
  client_phone   text NOT NULL,
  comment        text,
  items          jsonb NOT NULL DEFAULT '[]',   -- [{title, qty, price}]
  price          numeric(12,2),
  payment        text,                          -- cash | card | prepaid

  pickup_address text,
  pickup_point   geography(Point,4326),
  drop_address   text NOT NULL,
  drop_point     geography(Point,4326),

  deliver_from   timestamptz,                   -- слот доставки
  deliver_to     timestamptz,
  sla_deadline   timestamptz,

  public_token   text NOT NULL UNIQUE,
  version        integer NOT NULL DEFAULT 1,    -- оптимистичная блокировка
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,
  UNIQUE (tenant_id, number)
);

CREATE INDEX ON orders (tenant_id, status) WHERE status NOT IN ('delivered','canceled');
CREATE INDEX ON orders (courier_id) WHERE status NOT IN ('delivered','canceled');
CREATE INDEX ON orders USING GIST (drop_point);

-- история статусов (аудит: кто, когда, откуда)
CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id),
  from_status order_status,
  to_status   order_status NOT NULL,
  point       geography(Point,4326),       -- где был курьер в момент нажатия
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── геотрек ───────────────────────────────────────────────────────
CREATE TABLE courier_positions (
  courier_id  uuid NOT NULL,
  ts          timestamptz NOT NULL,
  point       geography(Point,4326) NOT NULL,
  accuracy    real,
  speed       real,
  heading     real,
  battery     smallint,
  PRIMARY KEY (courier_id, ts)
) PARTITION BY RANGE (ts);
-- партиции на сутки создаёт cron-джоба, старше 30 дней — DROP

-- ── чат ───────────────────────────────────────────────────────────
CREATE TYPE chat_scope AS ENUM ('order','dispatch');  -- по заказу / общий чат смены

CREATE TABLE chat_threads (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  scope      chat_scope NOT NULL,
  order_id   uuid REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id   uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES users(id),          -- NULL = клиент по public_token
  author_kind text NOT NULL,                      -- dispatcher|courier|client|system
  body        text,
  attachments jsonb NOT NULL DEFAULT '[]',
  client_msg_id text,                             -- идемпотентность отправки
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, client_msg_id)
);
CREATE INDEX ON chat_messages (thread_id, created_at DESC);

CREATE TABLE chat_reads (
  thread_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  read_at    timestamptz NOT NULL,
  PRIMARY KEY (thread_id, user_id)
);

-- ── журнал изменений: сердце синхронизации ────────────────────────
CREATE TABLE change_log (
  seq        bigserial PRIMARY KEY,     -- глобально возрастающий курсор
  tenant_id  uuid NOT NULL,
  topic      text NOT NULL,             -- 'order' | 'courier' | 'chat'
  entity_id  uuid NOT NULL,
  event      text NOT NULL,             -- 'order.status_changed'
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON change_log (tenant_id, seq);
```

### Стейт-машина заказа

```
new ──assign──> assigned ──accept──> accepted ──pickup──> picked_up ──go──> en_route ──> delivered
 │                  │                    │                    │                │
 └──────────────────┴────────────────────┴────────────────────┴────────────────┴──> canceled / failed
```

Переходы описываются одной таблицей-константой, а не `if`-ами по коду:

```ts
const TRANSITIONS: Record<OrderStatus, { to: OrderStatus; by: Role[] }[]> = {
  new:       [{ to: 'assigned',  by: ['dispatcher'] }, { to: 'canceled', by: ['dispatcher'] }],
  assigned:  [{ to: 'accepted',  by: ['courier'] },    { to: 'new', by: ['dispatcher','courier'] }],
  accepted:  [{ to: 'picked_up', by: ['courier'] },    ...],
  // ...
};
```
Любой переход вне таблицы → `409 InvalidTransition`. Это защищает от гонок на плохой связи: курьер нажал «Доставлено» дважды из офлайна — второй раз отлетит.

---

## 5. Realtime-контракт

### Комнаты

| Комната | Кто внутри | Что получает |
|---|---|---|
| `t:{tenantId}:dispatch` | диспетчеры и владелец | всё: заказы, курьеры, чаты, метрики |
| `t:{tenantId}:courier:{userId}` | один курьер (все его вкладки/устройства) | только его заказы |
| `order:{orderId}` | участники заказа | чат и статусы заказа |
| `track:{publicToken}` | клиент по ссылке | урезанный статус + позиция курьера |

Вход в комнаты — **только на сервере** в `handleConnection` по данным из JWT. Никаких `socket.on('join', room => socket.join(room))` — это дыра, через которую чужой тенант читает ваши заказы.

### События сервер → клиент

```
sync.snapshot        { seq, orders[], couriers[], threads[] }   — при подключении
order.created        { order }
order.updated        { order, changed: string[] }
order.status_changed { orderId, from, to, actor, at, version }
courier.location     { courierId, lat, lng, heading, speed, ts }
courier.state        { courierId, state }
chat.message         { threadId, message }
chat.read            { threadId, userId, readAt }
dashboard.metrics    { active, late, avgDeliveryMin, byStatus{} }
system.notice        { level, text }        — эскалации, SLA
```

### События клиент → сервер (все с ack-колбэком)

```
order.assign      { orderId, courierId, version }      -> { ok, order } | { ok:false, code:'CONFLICT' }
order.setStatus   { orderId, to, version, point? }     -> { ok, order }
chat.send         { threadId, body, clientMsgId }      -> { ok, message }
chat.typing       { threadId }                         -> —
location.push     { points: [{lat,lng,ts,acc,speed}] } -> { ok, accepted }
sync.since        { seq }                              -> { ok, events[], seq }
```

### Как гарантируется, что все видят одно и то же

Это ключевая часть, ради неё и продукт.

**1. Единая точка записи.** Никогда не эмитить из контроллера/гейтвея напрямую. Любая мутация проходит через сервис, который в **одной транзакции** пишет сущность + `change_log`. Только после коммита событие уходит в шину.

```ts
async setStatus(cmd: SetStatusCmd): Promise<Order> {
  const evt = await this.ds.transaction(async (m) => {
    const order = await m.findOne(Order, { where: { id: cmd.orderId }, lock: { mode: 'pessimistic_write' } });
    assertTransitionAllowed(order.status, cmd.to, cmd.actorRole);

    const res = await m.update(Order,
      { id: order.id, version: cmd.version },              // ← оптимистичная блокировка
      { status: cmd.to, version: () => 'version + 1', updated_at: new Date() });
    if (res.affected === 0) throw new ConflictException('STALE_VERSION');

    await m.insert(OrderEvent, { ... });
    return m.save(ChangeLog, { tenant_id, topic: 'order', event: 'order.status_changed', payload });
  });

  this.bus.publish(evt);   // после коммита — иначе клиент прочитает то, чего ещё нет в БД
  return ...;
}
```

**2. Версия у каждой сущности.** Клиент шлёт `version`, которую видит. Если два диспетчера одновременно назначили заказ разным курьерам — второй получит `CONFLICT`, а не тихую перезапись. UI покажет «Заказ №14 уже взял Игорь».

**3. Курсор `seq` и догон после разрыва.** Каждый клиент помнит последний `seq`. При реконнекте (а он будет: метро, деплой, лифт) шлёт `sync.since { seq }` и получает **все пропущенные события** из `change_log`, а не «пустой экран до F5». Если разрыв больше 5 минут или `seq` слишком старый — сервер отвечает `RESYNC`, клиент запрашивает полный `sync.snapshot`. Это и есть корректная работа при N инстансах: неважно, на какой процесс тебя перекинуло, курсор общий.

**4. Идемпотентность.** У команд от курьера — `clientMsgId` / `Idempotency-Key`. Тапнул «Доставлено», связь пропала, клиент повторил — повтор вернёт тот же результат, а не создаст второе событие.

**5. Порядок.** Socket.IO гарантирует порядок в рамках соединения. Между разными инстансами — нет, поэтому источник истины по порядку это `seq` из БД; клиент применяет события с `seq <= last` как no-op.

---

## 6. Геотрекинг — как не убить сервер и батарею

**Клиент курьера:**
- `watchPosition` с `enableHighAccuracy`, но отправка **батчем раз в 10 сек** (3–5 точек в одном сообщении), а не по каждому тику.
- Точки копятся в IndexedDB при офлайне и досылаются при появлении сети (по `ts`, сервер сам разложит).
- Не шлём, если смещение < 15 м и прошло < 30 сек (курьер стоит на светофоре).

**Сервер (`location.push`):**
1. Отбросить мусор: `accuracy > 100м`, `ts` в будущем, прыжок > 200 км/ч.
2. `SETEX courier:{id}:pos 60 <json>` в Redis + `GEOADD couriers:live` — горячее чтение.
3. Пачкой в `courier_positions` (`INSERT ... ON CONFLICT DO NOTHING`), не по одной точке.
4. Broadcast **с троттлингом**: не чаще 1 раза в 3 сек на курьера и только в комнаты, где реально кто-то смотрит (`server.sockets.adapter.rooms.get(room)?.size`). Клиенту заказа шлём координаты, только пока `status IN ('picked_up','en_route')` — иначе утечка приватности курьера.

**Геофенсинг:** курьер вошёл в радиус 150 м от точки доставки → автоматически `system` сообщение «Курьер рядом» клиенту + пуш. Считается на PostGIS `ST_DWithin`, дёшево.

### 6.1 Главный риск продовой версии: фоновая геолокация

Живой трекинг — центральная фича продукта, и именно она хуже всего живёт в вебе. **iOS Safari останавливает `watchPosition`, когда экран заблокирован или вкладка ушла в фон.** Android мягче, но тоже усыпляет вкладку. То есть PWA отдаёт координаты, только пока курьер держит приложение открытым на включённом экране.

Это не повод менять архитектуру бэкенда: серверный контракт (`location.push` с батчами) одинаков для любого источника точек. Но выбрать клиента нужно осознанно.

| Вариант | Что даёт | Цена |
|---|---|---|
| **PWA + Wake Lock API** (MVP) | Экран не гаснет, точки идут стабильно | Батарея; для авто/скутера с держателем норм, пешему тяжело |
| **Capacitor-обёртка** над той же PWA + background-geolocation плагин | Настоящий фон, кода переписывать не нужно | ~неделя работы, Apple Developer $99/год |
| **Telegram Live Location** | Настоящий фон бесплатно — Telegram нативный и уже стоит у курьера | Точки раз в ~15–60 с, курьер включает шаринг вручную, лимит 8 часов |

**Решение:** MVP — PWA + Wake Lock, честно предупреждая клиента, что телефон курьера должен быть в держателе. Прод — Capacitor, как только появятся платящие клиенты (обёртка ставится поверх готового фронта, переделок нет). Telegram-бот — запасной путь, если упрёшься в модерацию App Store; он реализуется как ещё один источник событий (вебхук → тот же сервис → та же шина), бизнес-логику в боте не дублируем.

Деградация должна быть предусмотрена в UI с самого начала: если от курьера нет точек больше 2 минут, диспетчер видит серый маркер и «последний раз в 14:19», а не устаревшую позицию как живую.

---

## 7. Дашборд без нагрузки на БД

Метрики (активных заказов, просрочено, среднее время доставки, загрузка курьеров) не считать SQL-ом на каждый рендер. Схема:

1. Materialized-состояние в Redis-хеше `t:{id}:metrics`, инкрементально обновляется тем же сервисом, что пишет `change_log`.
2. Раз в 5 секунд worker публикует `dashboard.metrics` в комнату диспетчера — все инстансы разошлют своим.
3. Раз в минуту — сверка полным `SELECT` (защита от расхождения счётчиков).

Тяжёлая аналитика (отчёт за месяц, пробег курьера) — отдельный REST-эндпоинт с материализованным представлением, обновляемым ночью.

---

## 8. REST API (то, что не realtime)

```
POST   /auth/login                 → { access, refresh(cookie) }
POST   /auth/refresh
POST   /auth/logout

GET    /orders?status&courier&from&to&cursor     — список, keyset-пагинация
POST   /orders                                   — создать (форма/интеграция/бот)
GET    /orders/:id
PATCH  /orders/:id                               — редактирование карточки (If-Match: version)
POST   /orders/:id/assign        { courierId }
POST   /orders/:id/status        { to, point? }
GET    /orders/:id/track         — трек курьера по заказу (GeoJSON LineString)

GET    /couriers                 — список + состояние + последняя позиция
POST   /couriers/:id/shift       { action: start|end }
POST   /locations                { points: [...] }  — ОБЯЗАТЕЛЬНЫЙ дубль WS-события
                                   location.push. Нативный фоновый геоплагин шлёт
                                   точки сам, по HTTP, вне JS-контекста приложения
                                   (см. 3.9). Тот же сервис, та же валидация.

GET    /threads/:id/messages?before=&limit=      — история чата (WS отдаёт только новое)
POST   /uploads/sign             { mime, size } → presigned PUT в S3

GET    /public/track/:token      — публичный статус заказа (rate-limited)

GET    /reports/daily?date=      — сводка за день
GET    /health, /metrics         — liveness + Prometheus
```

**Правило:** WS — только для «нового и живого». История, пагинация, отчёты — REST. Не тащить в сокет то, что прекрасно кешируется HTTP-ом.

---

## 9. Совместное редактирование (фаза 4)

Реальный сценарий, а не галочка: **план смены/маршрутный лист**, который два диспетчера правят одновременно (порядок точек, заметки по клиентам, чек-лист загрузки).

- **Yjs** (CRDT) + `y-socket.io` на отдельном namespace `/collab`.
- Почему CRDT, а не OT: не нужен центральный сервер-арбитр порядка, корректно работает при офлайне и реконнекте (что для нас и так базовый режим), и есть готовые биндинги под редакторы.
- Персист: снапшот `Y.Doc` в `bytea` в Postgres, дебаунс 2–5 сек + при отсутствии активных клиентов.
- Awareness (курсоры, «кто где») — через тот же Redis pub/sub, состояние эфемерное, в БД не пишем.
- Мультиинстанс: `y-redis` либо привязка комнаты документа к инстансу через consistent hashing.

---

## 10. Безопасность

- **Мультиарендность:** `tenant_id` в каждом запросе берётся **из токена**, никогда из body/query. Общий `TenantGuard` + репозиторий-обёртка, которая автоматически добавляет `WHERE tenant_id = :ctx`. Опционально — Row Level Security в Postgres как второй рубеж.
- Rate limit: `@nestjs/throttler` на REST, свой лимитер на WS-события (`location.push` — 30/мин, `chat.send` — 20/мин).
- Публичный трекинг: opaque токен (не угадывается перебором), TTL, урезанный DTO, отдельный лимит по IP.
- Пароли — argon2id. Телефоны клиентов в логи не пишем.
- Загрузка файлов — только presigned PUT напрямую в S3, с проверкой mime и лимитом размера; бэкенд файлы не проксирует.
- Аудит: `order_events` + `change_log` дают полную реконструкцию «кто что сделал» — для разбора «клиент говорит, что не привезли».

---

## 11. Наблюдаемость и эксплуатация

- Метрики Prometheus: количество WS-соединений на инстанс, лаг `change_log`, длина очередей BullMQ, p95 времени обработки события, доля `CONFLICT`-ответов.
- Логи структурные (pino) с `traceId`, прокинутым из WS-хендшейка.
- Graceful shutdown: при SIGTERM — `server.close()`, ждём 10 сек, чтобы клиенты успели переподключиться на живые инстансы; k8s `preStop` + `terminationGracePeriodSeconds: 30`.
- Health: `/health/live` (процесс жив) и `/health/ready` (есть Postgres + Redis) — иначе LB отправит трафик на инстанс без Redis, и рассылка молча сломается.

---

## 12. План по этапам

**Фаза 0 — фундамент (3–5 дней)**
Чистка `package.json` от наследия прошлого проекта, docker-compose (postgres+postgis, redis, minio), миграции TypeORM (`synchronize: false`!), валидация `.env` через `class-validator`, auth + JWT + guards, tenant-контекст, health-чеки, Swagger на `/docs`.

**Фаза 1 — заказы и realtime-ядро (1–1.5 недели)**
CRUD заказов, стейт-машина, `change_log` + шина, Redis-адаптер, комнаты, `sync.snapshot` / `sync.since`, оптимистичная блокировка. **Критерий готовности:** поднимаем 2 инстанса, диспетчер на одном, курьер на другом — назначение видно мгновенно; убиваем инстанс курьера — он переподключается и догоняет пропущенное без перезагрузки страницы.

**Фаза 2 — чат (3–4 дня)**
Треды, история через REST, доставка через WS, идемпотентность по `clientMsgId`, вложения через presigned S3, непрочитанные, typing.

**Фаза 3 — карта и трекинг (1 неделя)**
`location.push` с батчами и фильтрами, Redis GEO, партиционированный трек, троттлинг рассылки, геокодинг адресов, ETA, геофенсинг «курьер рядом», публичная страница трекинга.

**Фаза 4 — дашборд и SLA (4–5 дней)**
Инкрементальные метрики, BullMQ-таймеры и эскалации, отчёт за день, Web Push, SMS клиенту.

**Фаза 5 — совместное редактирование (1 неделя)**
Yjs, план смены, персист, awareness.

---

## 13. Что поправить в текущем коде

1. **`src/app.module.ts:22`** — `AppGateway` стоит в `imports`, а должен быть в `providers`. В `imports` Nest ждёт модули; гейтвей там либо упадёт, либо не поднимется.
2. **`src/app.module.ts:19`** — `synchronize: true` на Postgres. Для этого проекта опасно: тихо дропает колонки. Переходим на миграции сразу, до первых данных.
3. **`src/chat/chat.gateway.ts`** — целиком удалить. Это прототип чата с Gemini от прошлого проекта: клиент `GoogleGenAI` создаётся на каждое сообщение, а `this.server.emit(...)` шлёт **всем подключённым**, включая чужие тенанты. Переписывать нечего — гейтвей «Диспетчерской» пишется с нуля под комнаты и авторизацию.
4. `@WebSocketGateway()` без опций — в новом гейтвее задать `namespace`, `cors` и `transports` явно.

**Из `package.json` выкинуть** (наследие проекта «детский чат», к диспетчерской отношения не имеют):

```bash
npm rm @google/genai grammy @grammyjs/files zod @nestjs/class-validator @types/socket.io
```

- `@google/genai`, `grammy`, `@grammyjs/files` — ИИ-чат и Telegram-бот, ни то ни другое в продукт не входит.
- `zod` — валидируем штатным `class-validator` (см. 3.7).
- `@nestjs/class-validator` — форк-обёртка, конфликтует с обычным `class-validator`, который уже стоит. Оставляем один канонический пакет.
- `@types/socket.io` — устаревший пакет-заглушка, socket.io давно везёт типы с собой.

---

## 14. Итоговый список зависимостей к установке

```bash
npm i socket.io @socket.io/redis-adapter ioredis \
      bullmq @nestjs/bullmq \
      @nestjs/jwt @nestjs/passport passport passport-jwt argon2 \
      @nestjs/swagger \
      @nestjs/throttler nestjs-pino pino-http \
      web-push \
      @aws-sdk/client-s3 @aws-sdk/s3-request-presigner \
      @nestjs/terminus @willsoto/nestjs-prometheus prom-client
```

Уже стоят и остаются: `@nestjs/websockets`, `@nestjs/platform-socket.io`, `@nestjs/typeorm`, `typeorm`, `pg`, `class-validator`, `class-transformer`, `@nestjs/config`, `cookie-parser`.

Позже (фаза 5): `yjs y-socket.io y-protocols`.
