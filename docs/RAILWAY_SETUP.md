# Деплой на Railway

Docker не требуется: Railway собирает проект через Nixpacks по `railway.toml`.

## 1. Проект и база

1. Создайте проект в Railway и подключите GitHub-репозиторий.
2. Добавьте плагин **PostgreSQL** — Railway выдаст переменную `DATABASE_URL`.
3. Ссылку на базу используйте через Reference Variable, чтобы не копировать пароль вручную.

## 2. API Service

- Build Command: `npm ci && npm run db:generate && npm run build` (уже в `railway.toml`)
- Start Command: `npm run db:migrate:deploy && npm run start`
- Healthcheck Path: `/health`
- Node версия: 22 (задана в `.nvmrc` и `engines`)

## 3. Cron Service

Создайте **второй сервис из того же репозитория**:

- Start Command: `npm run db:migrate:deploy && npm run cron:simulate`
- Cron Schedule: `*/15 * * * *`

Сервис выполняет одну симуляцию следующего раунда и завершается. Railway планирует расписание
в UTC, а окна раундов считаются в `APP_TIMEZONE` (`Asia/Almaty`) — при интервале 15 минут
сдвиг часовых поясов не влияет на границы окон.

Альтернатива (если Cron-сервисы недоступны): запустите тот же сервис как постоянный процесс
с командой `npm run cron:simulate -- --watch` или переменной `CRON_LONG_RUNNING=true` —
расписание тогда держит node-cron внутри процесса.

## 4. Переменные окружения

Обязательные:

```env
NODE_ENV=production
DATABASE_URL=<reference на Postgres>
ADMIN_API_KEY=<длинный случайный ключ>
CORS_ORIGINS=https://<ваш-cloudflare-домен>
APP_TIMEZONE=Asia/Almaty
```

Опциональные (по мере подключения интеграций): `IIKO_*`, `TELEGRAM_*`, `FRONT_PLUGIN_*`,
`PRICE_*`. Полный список с описаниями — в `.env.example`.

### iiko Cloud API (v2)

Бэкенд использует endpoints iiko Cloud API v2:

- `POST /api/v2/access_token` — авторизация по `apiLogin` + `appId` + `clientSecret`.
  Токен живёт только в памяти процесса и никогда не пишется в БД, логи, ответы,
  HTML, Swagger или audit log.
- `POST /api/v2/menu` — запрос внешнего меню с Bearer-токеном.
  Тело: `{ externalMenuId, organizationIds: [organizationId] }`.

Переменные iiko для Railway:

```env
IIKO_API_BASE_URL=https://api-ru.iiko.services/api/1
IIKO_API_KEY=<apiLogin>
IIKO_APP_ID=<appId>
IIKO_CLIENT_SECRET=<clientSecret>
IIKO_AUTH_PATH=/api/v2/access_token
IIKO_AUTH_RETURN_ADDITIONAL_INFO=false
IIKO_AUTH_INCLUDE_DISABLED=false
IIKO_ORGANIZATION_ID=<organizationId>
IIKO_EXTERNAL_MENU_ID=<externalMenuId>
IIKO_SYNC_ENABLED=true
```

`IIKO_API_BASE_URL` исторически содержит `/api/1`, но клиент строит итоговые URL
от нормализованного корня, поэтому `/api/1` не дублируется: итоговый URL авторизации
= `https://api-ru.iiko.services/api/v2/access_token`, меню =
`https://api-ru.iiko.services/api/v2/menu`.

Двухстадийная диагностика (auth + menu) доступна на
`GET /api/v1/admin/iiko/auth-diagnostics` и в админ-панели (/admin). Эндпоинт
возвращает upstream HTTP-статус и `correlationId` для каждой стадии, но никогда
не раскрывает секреты, токен или тело запроса. Ошибки меню отмечаются отдельно и
не маскируются под `IIKO_AUTH_FAILED`.

Рекомендации:

- `ADMIN_API_KEY` генерируйте как `openssl rand -hex 32`;
- значения секретов задавайте только в Railway Variables, не в репозитории;
- `PRICE_PUBLISHER_MODE=disabled` — безопасный режим v0.1 (в iiko ничего не отправляется).

## 5. Проверка после деплоя

```bash
curl https://<домен>/health
curl https://<домен>/api/v1/public/prices
curl -H "x-admin-api-key: $ADMIN_API_KEY" https://<домен>/api/v1/admin/diagnostics
open https://<домен>/admin
```

Swagger доступен на `https://<домен>/docs`.

## 6. Cloudflare Pages (frontend)

Добавьте домен фронтенда в `CORS_ORIGINS` (через запятую можно несколько). Фронтенд должен
использовать только публичные эндпоинты `/api/v1/public/*` — админ-ключ на клиент не передаётся.

## 7. Миграции

`npm run db:migrate:deploy` выполняется при каждом старте, поэтому новые миграции применяются
автоматически. Никогда не запускайте `prisma migrate dev` против production-базы.
