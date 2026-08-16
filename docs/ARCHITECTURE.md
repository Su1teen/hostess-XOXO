# Архитектура Bar Exchange Backend

## Обзор

Backend — источник истины по биржевым товарам, ценам и раундам. Он:

1. читает данные из iiko Cloud (организации, номенклатура, стоп-листы);
2. хранит выбранные администратором биржевые товары в PostgreSQL;
3. каждые 15 минут рассчитывает цены следующего раунда;
4. после согласования публикует цены и отдаёт их публичному API;
5. пишет аудит, ошибки и результаты интеграций;
6. предоставляет контракт `price-quote` для будущего iikoFront plugin.

**v0.1 не пишет в iiko.** Публикация меняет только данные backend-а.

## Слои

```
src/
  app.ts                 сборка Fastify: плагины, роуты, обработчики ошибок
  server.ts              запуск, graceful shutdown
  config/                env (Zod) и константы алгоритма
  plugins/               logger, prisma, auth, security, swagger
  modules/               HTTP-модули: health, public-api, admin, iiko,
                         products, rounds, telegram, webhooks, front-plugin
  services/              бизнес-логика: price-engine, price-publisher,
                         iiko-client, telegram, audit, container
  jobs/                  simulate-round.job.ts (Railway Cron)
  lib/                   errors, time, money, redaction, idempotency
```

Правила:

- HTTP-модули не знают про iiko-протокол — только сервисы;
- `price-engine` — чистая функция без БД и сети;
- все денежные значения — `Decimal` (Prisma `Decimal` в БД), без float-арифметики;
- время раундов считается в `APP_TIMEZONE` (по умолчанию `Asia/Almaty`).

## Данные (Prisma)

| Модель            | Назначение                                               |
| ----------------- | -------------------------------------------------------- |
| `Organization`    | Организация iiko, одна выбрана как активная              |
| `ProductGroup`    | Группы номенклатуры iiko                                 |
| `Product`         | Товар: iiko-идентификаторы, цены, флаг биржевого товара  |
| `PriceRound`      | 15-минутный раунд и его статус                           |
| `RoundPrice`      | Цена товара в раунде + метаданные расчёта                |
| `SalesEvent`      | События продаж из webhook-а (идемпотентно)               |
| `IikoSyncAttempt` | Каждая попытка обращения к iiko (метаданные, не payload) |
| `AuditLog`        | Действия администратора и системы                        |
| `AppSetting`      | Настройки времени выполнения                             |

Ключевые ограничения: уникальные `Organization.iikoId`,
`(organizationId, iikoProductId)`, `PriceRound.roundKey`, `(roundId, productId)`,
`(source, externalEventId)` для событий продаж.

Исчезнувшие из номенклатуры товары **архивируются**, а не удаляются.

## Расчёт цены

```
rawPrice     = currentPrice * (1 + k * demandScore)          k = 0.2
roundedPrice = roundToStep(rawPrice, priceStep)              step = 50 ₸
limited      = clamp(roundedPrice, ±maxChangePercent от currentPrice)
finalPrice   = clamp(roundToStep(limited), minPrice, maxPrice)
```

- `demandScore ∈ [-1, 1]`; при `0` цена не меняется;
- если `minPrice`/`maxPrice` не заданы — fallback `basePrice ± 20%`;
- округление до шага никогда не выводит цену за коридор `maxChangePercent`;
- версия алгоритма (`v0.1-linear-demand`), вход и результат расчёта сохраняются в `RoundPrice`.

## Жизненный цикл раунда

```
SIMULATED → APPROVED → PUBLISHED → (ROLLED_BACK)
                    ↘ CANCELLED
```

- `POST /admin/rounds/simulate` создаёт раунд для следующего окна (идемпотентно по `roundKey`);
- `approve` фиксирует согласование;
- `publish` переводит раунд в `PUBLISHED` и делает цены публичными;
- `rollback` возвращает предыдущий опубликованный раунд;
- `manual-export` отдаёт список цен для ручного переноса в iiko (без записи в iiko).

Публичное API отдаёт только раунд в статусе `PUBLISHED`, окно которого содержит текущий момент.

## Интеграции

- **iiko Cloud (read-only):** `access_token`, `organizations`, `nomenclature`, `stop_lists`,
  `api/2/menu`. Токен кэшируется в памяти, обновляется до истечения, повтор при сетевых ошибках,
  5xx и 429, один повтор с новым токеном при 401. 4xx не повторяются.
- **Webhook iiko:** `POST /api/v1/webhooks/iiko`, подпись `x-iiko-signature`, дедупликация по
  `externalEventId`, ответ `202` даже при неизвестной организации (чтобы не было бесконечных ретраев).
- **Telegram:** алерты об ошибках синхронизации и cron-а; выключены по умолчанию.
- **iikoFront plugin:** см. [FRONT_PLUGIN_CONTRACT.md](FRONT_PLUGIN_CONTRACT.md).

## Безопасность

Helmet, CORS-allowlist, rate-limit (жёстче для admin/webhook/plugin), лимит тела 512 КБ,
`x-request-id` в логах и ответах, timing-safe сравнение секретов, Pino-редакция секретов,
без стектрейсов в production.
