# Dispatchr — активные задачи

Формат: `DISP-N`. Статусы: `TODO` / `IN PROGRESS` / `DONE`.
Задача считается сделанной только когда выполнены **все** критерии приёмки.
После закрытия переезжает в `DONE.md` вместе с номером коммита и заметками.

Текущая фаза: **Фаза 0 — фундамент** (см. `docs.md` §12).
Закрыто: DISP-1, DISP-2 → `DONE.md`

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
6. Добавить в `.env` и `.env.example` недостающие ключи:
   `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`.
   Секреты генерировать, а не придумывать, и **разными** значениями:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
7. Первая миграция, руками (генерировать нечего — сущностей ещё нет):
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

## Бэклог фазы 0 (задачи распишем по мере готовности)

- **DISP-4** — сущности `tenants` / `users` / `courier_profiles` + миграция + сид
- **DISP-5** — Auth: login/refresh/logout, argon2, JwtStrategy, RolesGuard, tenant-контекст из токена
- **DISP-6** — `/health/live` и `/health/ready` (Postgres + Redis), Swagger на `/docs`,
  глобальный `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`
- **DISP-7** — pino с `traceId`, graceful shutdown по SIGTERM

**Критерий закрытия всей фазы 0:**
`docker compose up` → `npm run migration:run` → `npm run dev` → логин диспетчером
на `/auth/login` отдаёт access-токен, `/health/ready` возвращает 200 с живыми
Postgres и Redis, `/docs` открывается.
