# Dispatchr — трекер задач

Формат: `DISP-N`. Статусы: `TODO` / `IN PROGRESS` / `DONE`.
Задача считается сделанной только когда выполнены **все** критерии приёмки.

Текущая фаза: **Фаза 0 — фундамент** (см. `docs.md` §12).

---

## DISP-1 · Привести проект в собираемое состояние · TODO

**Зачем.** Сейчас `npm run build` упадёт: `app.module.ts` импортирует `./auth/auth.module`,
которого нет. Плюс в зависимостях лежит форк-валидатор из прошлого проекта, который
конфликтует с обычным `class-validator`. Пока проект не собирается — делать нечего.

**Шаги.**

1. `package.json` → поле `name`: `freelance` → `dispatchr`. Заполнить `description`.
2. Удалить конфликтующий пакет:
   ```
   npm rm @nestjs/class-validator
   ```
   Это форк-обёртка Nest поверх `class-validator`. Держать оба нельзя: декораторы
   из разных пакетов не видят метаданные друг друга, и валидация молча перестаёт
   срабатывать — самый неприятный тип бага, без ошибки в консоли.
3. `npm i` — поставить то, что уже прописано.
4. **Проверить, что реально встало под именем `typeorm`.** В `package.json` указано
   `"typeorm": "^1.0.0"` — версия подозрительная. Выполнить:
   ```
   npm ls typeorm
   ```
   Если резолвится во что-то странное или в пакет-пустышку — зафиксировать
   актуальную версию явно и переустановить.
5. Поставить зависимости, нужные **на фазу 0** (остальное из `docs.md` §14 ставим
   в своей фазе — чтобы каждый пакет попадал в проект осознанно, а не «пусть лежит»):
   ```
   npm i @nestjs/jwt @nestjs/passport passport passport-jwt argon2 \
         @nestjs/swagger @nestjs/terminus ioredis \
         nestjs-pino pino-http
   npm i -D @types/passport-jwt pino-pretty
   ```
   Осознанно откладываем: `socket.io` + `@socket.io/redis-adapter` (фаза 1),
   `bullmq` (фаза 4), `@aws-sdk/*` (фаза 2), `web-push` (фаза 4),
   `@nestjs/throttler` + Prometheus (перед первым деплоем).
6. Починить сборку: создать `src/auth/auth.module.ts` с **пустым** `@Module({})`.
   Содержимое появится в DISP-6 — сейчас задача только в том, чтобы импорт резолвился.
7. `.gitignore` — две правки:
   - строка `docs.md` в самом низу: убрать. ТЗ обязано лежать в репозитории,
     иначе оно живёт только у тебя на диске и теряется вместе с ним.
   - строка `.env*`: заменить на `.env` + `!.env.example`. Иначе шаблон конфига
     (понадобится в DISP-2) физически не сможет попасть в коммит.

**Критерии приёмки.**

- [ ] `npm run build` завершается без ошибок
- [ ] `npm ls @nestjs/class-validator` → пусто
- [ ] `npm ls typeorm` → внятная актуальная версия
- [ ] `git status` показывает `docs.md` как файл к добавлению
- [ ] Коммит: `chore: clean deps, fix build, rename project`

---

## DISP-2 · Инфраструктура в Docker: PostGIS + Redis + MinIO · TODO

**Зачем.** Три внешних сервиса из архитектуры (`docs.md` §2). Поднимаем все сразу,
одним `docker compose up`, чтобы не переписывать compose на каждой фазе.

**Предусловие:** запущен Docker Desktop.

**Шаги.**

1. **Заменить образ Postgres** на `postgis/postgis:16-3.4`.
   Текущий `postgres:16-alpine` — без PostGIS, `CREATE EXTENSION postgis` на нём
   упадёт. PostGIS нужен для радиусного поиска курьеров, зон доставки и
   геофенсинга (фаза 3). Данных пока нет — замена бесплатная, после первых данных
   это уже миграция тома.
   ⚠️ Если контейнер уже когда-то стартовал — удалить том:
   `docker compose down -v`. Иначе новый образ подхватит старый каталог данных.
2. **Добавить `redis:7-alpine`**, порт `6379`, со своим томом.
   В проекте у Redis четыре роли: pub/sub между инстансами, GEO-индекс живых
   позиций, локи/идемпотентность, очереди BullMQ (`docs.md` §3.2).
3. **Добавить MinIO** (`minio/minio`), порты `9000` (API) и `9001` (консоль),
   команда `server /data --console-address ":9001"`. S3-совместимое хранилище
   для фото доставки и вложений в чат.
4. **Healthcheck на каждом сервисе** — не для красоты: в DISP-7 эндпоинт
   `/health/ready` должен отличать «контейнер запущен» от «база готова принимать
   запросы». Ориентиры:
   - postgres: `pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB`
     (двойной `$$` обязателен — иначе compose подставит переменную сам)
   - redis: `redis-cli ping`
   - minio: `mc ready local`
5. **Привести `.env` в порядок.** Сейчас там плейсхолдеры (`POSTGRES_USER=POSTGRES_USER`).
   Нужный набор на фазу 0:
   ```
   NODE_ENV, PORT
   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
   REDIS_URL
   JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, JWT_ACCESS_TTL, JWT_REFRESH_TTL
   S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET
   ```
6. **Создать `.env.example`** — тот же набор ключей с пустыми/дефолтными
   значениями. Это единственная документация по конфигу, которая не устаревает,
   и в DISP-3 он станет источником правды для валидации.

**Критерии приёмки.**

- [ ] `docker compose up -d` поднимает три контейнера
- [ ] `docker compose ps` → у всех трёх статус `healthy` (не просто `running`)
- [ ] PostGIS отвечает:
      `docker compose exec postgres psql -U <user> -d <db> -c "CREATE EXTENSION IF NOT EXISTS postgis; SELECT postgis_version();"`
- [ ] Redis отвечает: `docker compose exec redis redis-cli ping` → `PONG`
- [ ] Консоль MinIO открывается на `http://localhost:9001`
- [ ] `docker compose down && docker compose up -d` — данные на месте (тома работают)
- [ ] `.env.example` попал в `git status` (если нет — вернуться к правке `.gitignore` из DISP-1)
- [ ] Коммит: `chore: postgis, redis and minio in docker-compose`

---

## DISP-3 · Валидация конфига + TypeORM на миграциях · TODO

**Зачем.** Две вещи, которые дешевле сделать сейчас и невозможно откатить потом.

Первая: приложение должно **падать на старте** от кривого `.env`, а не через час
в проде с `undefined` в строке подключения.

Вторая: `synchronize: true` в `app.module.ts:17` — это автоизменение схемы по
entity-классам. Оно молча дропает колонки при переименовании поля. Пока данных
нет, переход на миграции стоит полчаса; после первых боевых заказов — это ЧП.

**Шаги.**

1. `src/config/env.validation.ts`: класс `EnvConfig` с полями из `.env.example` и
   декораторами `class-validator` (`@IsString`, `@IsInt`, `@IsIn(['development','production'])`,
   `@MinLength(32)` на JWT-секретах). Экспортировать функцию `validate(config)`,
   которая гоняет `plainToInstance` + `validateSync` и **бросает исключение** на
   первой ошибке.
2. Подключить: `ConfigModule.forRoot({ isGlobal: true, validate })`.
3. Переписать `TypeOrmModule.forRoot` → `forRootAsync` с `inject: [ConfigService]`.
   Хост/порт/креды — из `ConfigService`, не из `process.env` напрямую.
   Поставить **`synchronize: false`**. Захардкоженный `host: 'localhost'` — убрать.
4. `src/database/data-source.ts` — отдельный `DataSource` для TypeORM CLI.
   Нужен именно отдельный: CLI запускается вне Nest-контекста и о `ConfigService`
   ничего не знает. Читает тот же `.env` через `dotenv`.
5. Скрипты в `package.json`:
   ```
   "migration:generate": "typeorm-ts-node-commonjs migration:generate -d src/database/data-source.ts",
   "migration:run":      "typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts",
   "migration:revert":   "typeorm-ts-node-commonjs migration:revert -d src/database/data-source.ts"
   ```
6. Первая миграция, руками (генерировать нечего — сущностей ещё нет):
   `CREATE EXTENSION IF NOT EXISTS postgis;` и `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
   (второе — для `gen_random_uuid()` в дефолтах первичных ключей, см. `docs.md` §4).
   В `down()` — соответствующие `DROP EXTENSION`.

**Критерии приёмки.**

- [ ] `npm run migration:run` применяет миграцию, в базе появилась таблица `migrations`
- [ ] `npm run migration:revert` откатывает её чисто
- [ ] `npm run dev` стартует и подключается к базе
- [ ] Убрать любую строку из `.env` → приложение **не стартует** и пишет, какой
      именно ключ отсутствует
- [ ] Поставить `JWT_ACCESS_SECRET=123` → приложение не стартует (сработал `@MinLength`)
- [ ] В коде не осталось `synchronize: true` и обращений к `process.env` из модулей
- [ ] Коммит: `feat: env validation and typeorm migrations`

---

## Бэклог фазы 0 (задачи заведём по мере готовности)

- **DISP-4** — сущности `tenants` / `users` / `courier_profiles` + миграция + сид
- **DISP-5** — Auth: login/refresh/logout, argon2, JwtStrategy, RolesGuard, tenant-контекст из токена
- **DISP-6** — `/health/live` и `/health/ready` (Postgres + Redis), Swagger на `/docs`,
  глобальный `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`
- **DISP-7** — pino с `traceId`, graceful shutdown по SIGTERM

**Критерий закрытия всей фазы 0:**
`docker compose up` → `npm run migration:run` → `npm run dev` → логин диспетчером
на `/auth/login` отдаёт access-токен, `/health/ready` возвращает 200 с живыми
Postgres и Redis, `/docs` открывается.
