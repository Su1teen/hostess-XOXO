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
