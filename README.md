# Bar Exchange Backend (v0.1)

Backend системы динамических цен бара «Bar Exchange». Хранит биржевые товары, считает цены
15-минутными раундами, отдаёт публичные цены для фронтенда на Cloudflare Pages, ведёт аудит
и готовит контракт для будущего iikoFront plugin.

> **Важная граница v0.1.** Backend **не меняет кассовую цену в iikoFront** и вообще не выполняет
> никаких записывающих запросов в iiko. Интеграция с iiko Cloud используется только для чтения
> (токен, организации, номенклатура, стоп-листы). Публикация раунда фиксирует цену в PostgreSQL
> и делает её доступной публичному API — это подготовка контракта для будущего плагина кассы.

## Стек

- Node.js 22 LTS, TypeScript (strict)
- Fastify 5, Zod, Pino
- PostgreSQL + Prisma
- node-cron, Luxon, Decimal.js
- Vitest, ESLint, Prettier
- Деплой: Railway (через GitHub), без Docker

## Быстрый старт (локально)

```bash
cp .env.example .env      # заполните DATABASE_URL и ADMIN_API_KEY
npm install
npm run db:migrate:dev
npm run db:seed           # ровно 27 идемпотентных exchange products
npm run dev
```

Проверка:

```bash
curl localhost:3000/health
open http://localhost:3000/docs     # Swagger UI
open http://localhost:3000/admin    # страница диагностики (RU)
```

Админ-эндпоинты требуют заголовок `x-admin-api-key` (имя заголовка настраивается через
`ADMIN_API_KEY_HEADER`).

## Скрипты

| Скрипт                      | Назначение                           |
| --------------------------- | ------------------------------------ |
| `npm run dev`               | Локальный запуск с автоперезагрузкой |
| `npm run build`             | Сборка в `dist/`                     |
| `npm run typecheck`         | Проверка типов production-кода       |
| `npm start`                 | Запуск собранного сервера            |
| `npm run lint`              | ESLint без предупреждений            |
| `npm run format`            | Prettier                             |
| `npm test`                  | Vitest                               |
| `npm run db:migrate:dev`    | Миграции для разработки              |
| `npm run db:migrate:deploy` | Миграции для production              |
| `npm run db:seed`           | 27 идемпотентных exchange products   |
| `npm run cron:simulate`     | Одна симуляция следующего раунда     |

## API

Публичное (для Cloudflare-фронтенда, только опубликованные данные):

- `GET /health`
- `GET /api/v1/public/health`
- `GET /api/v1/public/current-round` (legacy alias)
- `GET /api/v1/public/prices` (legacy alias)
- `GET /api/v1/public/products` — только активные биржевые товары
- `GET /api/v1/public/rounds/current` — опубликованный текущий раунд и цены
- `GET /api/v1/public/rounds/next` — начало следующего раунда и countdown

Административное (`x-admin-api-key`):

- `GET /api/v1/admin/diagnostics`
- `POST /api/v1/admin/iiko/test-connection`
- `POST /api/v1/admin/iiko/sync-organizations`, `GET /api/v1/admin/iiko/organizations`
- `POST /api/v1/admin/iiko/select-organization`
- `POST /api/v1/admin/iiko/sync-menu`, `GET /api/v1/admin/iiko/groups`
- `GET /api/v1/admin/products`, `GET|PATCH /api/v1/admin/products/:id`,
  `POST /api/v1/admin/products/:id/select-for-exchange`,
  `POST /api/v1/admin/products/:id/remove-from-exchange`
- `GET|POST /api/v1/admin/rounds…` (`simulate`, `approve`, `publish`, `rollback`, `manual-export`)
- `POST /api/v1/admin/rounds/:roundId/sales/increment` — тестовый атомарный increment продаж
- `POST /api/v1/admin/telegram/test`

Панель бармена (вход по PIN, далее заголовок `x-bartender-token`):

- `POST /api/v1/bartender/auth`, `POST /api/v1/bartender/logout`
- `GET /api/v1/bartender/exchange/products`, `GET /api/v1/bartender/exchange/status`
- `POST /api/v1/bartender/exchange/products/:id/price-preview` — расчёт без записи в БД
- `POST /api/v1/bartender/exchange/products/:id/apply-price` — цена считается на сервере
- `POST /api/v1/bartender/exchange/products/:id/sales/increment|decrement`

Интеграции:

- `POST /api/v1/webhooks/iiko` — приём событий продаж (идемпотентно)
- `POST /api/v1/front-plugin/price-quote` — контракт будущего плагина, по умолчанию выключен

Полное описание — в `/docs` (Swagger) и в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Документация

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, данные, жизненный цикл раунда
- [docs/IIKO_SETUP.md](docs/IIKO_SETUP.md) — настройка iiko Cloud
- [docs/RAILWAY_SETUP.md](docs/RAILWAY_SETUP.md) — деплой и cron
- [docs/FRONT_PLUGIN_CONTRACT.md](docs/FRONT_PLUGIN_CONTRACT.md) — контракт iikoFront plugin
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — эксплуатация, инциденты, восстановление

## Безопасность

- Секреты только через переменные окружения; в коде и логах их нет (Pino-редакция).
- Сравнение админ-ключа и plugin-секрета — timing-safe.
- Helmet, CORS-allowlist, rate-limit (жёстче для admin/webhook/plugin), лимит тела запроса.
- В production не отдаются стектрейсы; сырые payload-ы iiko логируются только при
  `IIKO_DEBUG_RAW_PAYLOADS=true` и проходят редакцию.

## Exchange foundation (этап 1)

Для migration и production используйте `npm run db:migrate:deploy`, для локальной разработки —
`npm run db:migrate:dev`, затем `npm run db:seed`. Seed не импортирует `drinks_output.json`, не
создаёт iiko товары и безопасен для повторного запуска: ключи `exchange-01`…`exchange-27`
уникальны. Для этих позиций iiko IDs nullable и не используются в расчёте. Биржа стартует с
`minPrice`, `originalPrice` — цена меню без скидки, `maxPrice` равен `originalPrice * 1.5`,
округлённому до `priceStep` (50 KZT). Все цены — Decimal в KZT.

Автоматический cron и crash-обвалы не запускаются; `CRASH` и
`CrashEvent` существуют только как foundation. iiko остаётся read-only, iikoFront plugin не
подключается. Для CI/локального окружения нужны `DATABASE_URL` и `ADMIN_API_KEY` (минимум 16
символов); остальные переменные имеют значения по умолчанию из `.env.example`.

## Режим «Бармен» на странице `/admin`

На `/admin` есть кнопка «Бармен»: она открывает отдельную рабочую область на весь экран
и скрывает техническую диагностику (без удаления её из кода). Вход — по PIN смены,
админ-ключ там не нужен и не используется. PIN проверяется один раз, далее работает
короткоживущий токен в заголовке `x-bartender-token`; в URL и логи PIN не попадает.

Настройка PIN: `BARTENDER_PIN_HASH` (sha256 hex от PIN) — предпочтительно, либо временно
`BARTENDER_PIN` (по умолчанию `1234`). PIN не равен `ADMIN_API_KEY`.

Скидка всегда считается на сервере от цены меню:
`final = max(round50(originalPrice * (1 - p/100)), minPrice)`. Выбранный и фактический процент
хранятся отдельно; при упоре в `minPrice` панель показывает «Цена ограничена минимальной
ценой». Применённая цена становится канонической для публичного API. Продажи пишутся в
текущий раунд и не меняют цену сразу: спрос влияет на следующий раунд.

## Ограничения v0.1 и планы

- Нет записи в iiko: цены в кассе не меняются, заказы и прайс-листы не создаются.
- Публикация раунда = фиксация цены в БД + публичный API + ручной экспорт.
- Далее: iikoFront plugin (получение цены на кассе), полноценный расчёт спроса по продажам,
  автоматическая публикация прайсов после отдельного согласования безопасности.
