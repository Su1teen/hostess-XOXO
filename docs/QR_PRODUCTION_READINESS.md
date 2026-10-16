# QR production readiness — 17 октября 2026, UTC+05

## Статус и проверенные версии

**XOXO receiver включён и проверен в production. Полный live rollout: BLOCKED.** Отправитель остаётся выключенным; Hostess BFF возвращает configuration 503. Не считать HTTP 200 от health/snapshot доказательством принятого заказа. Настоящий ACK подтверждён в изолированном межсервисном E2E; production-заказы и бонусные операции не создавались.

- Исходный XOXO: `e9bbe282fad44eeb441cd4d39051e41f861dc04d`.
- Исправление учёта preview: `2164d54490a3bb3811fc46a0b019ee6d2976cf99`.
- Полный проверенный код XOXO, включая security-обновления: `aad6b2812df4d40764e9518c41f123f2fd588627`.
- Настоящий отправитель, повторно проверенный E2E: Command Center `97e9d91a47d9ae4211919dc5eb49e524235fad95`. Его `outbox.ts` не изменился относительно исходного `8fdac23fcfeb45b78f724f01ddb4e84a343fa2ee`.
- Этот отчёт хранится последующим коммитом: SHA выше относится к проверенному коду, а не к самому файлу отчёта.

## Production до выкладки

Railway project `hostess`, environment `production`; service `hostess-XOXO`. Исходный deployment `ed9fbd19-d697-4d6a-b85b-7e6d934bc5e6` SUCCESS. GitHub CI исходного main: [38936119919](https://github.com/Su1teen/hostess-XOXO/actions/runs/38936119919), SUCCESS.

| Настройка | Проверенный результат |
| --- | --- |
| XOXO QR_ORDER_EVENTS_ENABLED | Отсутствовал; authenticated diagnostics показал `enabled=false` |
| Command Center DINE_IN_OUTBOX_ENABLED | `no`; не включён этим аудитом |
| Command Center DINE_IN_ENABLED | `yes` |
| EXCHANGE_API_ORIGIN | `https://hostess-xoxo-production.up.railway.app` |
| COMMAND_CENTER_SERVICE_KEY | Оба значения совпадают; длина >=32; значения нигде не публикуются |
| HOSTESS_PUBLIC_ORIGIN | `https://hostes.online` |
| XOXO CORS_ORIGINS | Был только `https://barboard-exchange.sovetovsultann.workers.dev` |

После локальной проверки настроены `QR_ORDER_EVENTS_ENABLED=true` и CORS `https://barboard-exchange.sovetovsultann.workers.dev,https://hostes.online` с `--skip-deploys`. Их применение к новому запущенному контейнеру подтверждено после доставки main, см. финальный раздел. Существующий доверенный биржевой frontend сохранён. Service key не добавлен в browser headers; ORDER_ACCEPTED/ORDER_CANCELLED контракт не менялся.

Env precedence: приложение получает Railway process.env, `getEnv()` кэширует результат `parseEnv()`. Загрузчика dotenv/переопределения флага в старте нет. Default false; true/yes/1/on включают флаг, false/no/0/off выключают. Изменение Railway variable требует нового запуска контейнера. Runtime start — только `npm run start`; Prisma deploy выполняется pre-deploy, seed/reset/db push на старте отсутствуют.

## Миграции и сохранность данных

Проверены actual PostgreSQL в `BEGIN READ ONLY` и Railway deploy logs. Все **10** XOXO миграций завершены, rolled_back_at отсутствует. `20261016160000_qr_order_events` завершена **2026-10-16T17:02:02.033Z**; логи 17:02:01–17:02:02Z подтверждают Applying migration и All migrations successfully applied.

В production существуют обе QR-таблицы, unique external_event_id, unique (command_center_order_item_id,event_type), PK delivery external_event_id, все четыре RESTRICT FK, проверки quantity>0, price>=0, разрешённых event_type/status и ожидаемые индексы. Локально migrations→schema diff: **No difference detected**; повторный migrate deploy: **No pending migrations to apply**. Production shared schema целиком не синхронизировалась: чужие таблицы Command Center Prisma XOXO не управляются. Production reset/db push/seed не выполнялись.

Начальный read-only diagnostics: events=[], deliveries=0, duplicates=0, rejectedAttempts=0. Независимый SELECT подтвердил exchange_order_events=0 и пустой integration_outbox. Это реальные нулевые счётчики, а не успешный live ACK.

## Исправления

1. Preview использовал ручные продажи активного раунда по текущим часам, а не источники заданного окна; после явной публикации исходный ручной раунд оставался незакрытым и мог учитываться повторно. Теперь snapshot под общей блокировкой фиксирует завершённые source rounds, ручные quantities и QR event IDs. Публикация атомарно проверяет snapshot, закрывает ручные источники и потребляет QR. Регрессия: manual=4 + QR=3 → preview=7 → следующий раунд=0.
2. После симуляции могли появиться отмена/новый accepted event/изменённый ручной counter. Устаревший preview теперь возвращает 409, не меняя ни события, ни цены; штатный transition пересчитывает актуальный спрос. Старые preview без source accounting и публикация до начала окна также отклоняются. Ценовая формула и уровни не переписаны.
3. Правильный домен добавлен в CORS, `.env.example` и Railway setup. Ошибочные ссылки в соседних репозиториях исправлены их параллельными аудитами; проверенный актуальный main Command Center больше не содержит неправильного домена.
4. Runtime dependency audit исходно: 8 уязвимых packages, включая critical. Обновлены Fastify 5.12.7, Swagger UI 6.1.2, Pino 9.14.0 и lockfile; для node-cron 3 оставлен прежний scheduler API с uuid 11.1.1 override. Совместимость Fastify 5 подтверждена метаданными самих плагинов. Runtime audit после чистого npm ci: **0 уязвимостей**. Dev/tooling audit отдельно остаётся вне runtime-показателя; полный npm audit не объявляется чистым.
5. Обновлённые HTTP-типы потребовали явного FastifyError и описания существующего health 503 в response schema. Ответы и бизнес-контракт сохранены.

## Выполненные проверки

Локально **Node 22.23.3 / PostgreSQL 18.4**. Чистый npm ci, Prisma generate/validate, migrations на пустых test DB, повторный deploy no-op, schema diff, typecheck, lint с zero warnings, build, contract suite и весь test suite прошли. **217 тестов / 16 файлов, пропусков нет**: 25 real PostgreSQL QR-тестов, 15 HTTP contract, 8 exchange pipeline, остальные price engine/bartender/iiko/products/money/env/deployment.

| Проверка | Статус | Доказательство / предел |
| --- | --- | --- |
| Новый accepted item: 3 × 1590 KZT | PASS | 3 единицы спроса, snapshot gross=4770 KZT; не количество event rows |
| eventId duplicate / новый ID того же item | PASS | Один event, отдельный receipt, ACK входящего eventId |
| Изменённые quantity/price/order/round | PASS | 409 conflict или 422 semantic validation; нового спроса нет |
| Cancellation до acceptance | PASS | 409 retryable; отправитель удерживает predecessor |
| Cancellation после / повтор cancellation | PASS | Полная компенсация один раз; positive quantity обоих типов |
| Concurrent delivery и publication | PASS | Shared advisory lock; одна обработка из 8 доставок |
| Concurrent bartender + QR | PASS | manual=4, QR=3 в отдельных источниках |
| 15-минутная граница / late delivery | PASS | [startsAt,endsAt); следующий неопубликованный расчёт, история не меняется |
| Поздняя отмена уже применённого спроса | PASS | HISTORICAL_ONLY; будущий спрос не отрицательный |
| Inactive product / historical price | PASS | Отмена принимается; 1590 snapshot не заменён новой ценой 2000 |
| Preview / повтор publication / recovery | FIXED | Спрос применяется один раз; новые inputs дают 409 |
| Сбой между event и receipt | PASS | DB trigger abort: обе записи откатились; retry затем ACK |
| Сбой публикации после расчёта | PASS | Вся transaction откатилась; recovery применяет 3 единицы один раз |
| Реальный restart/crash процесса XOXO | PASS | Два отдельных Node-процесса, принудительное завершение между ними; durable duplicate ACK, events остаются 2 |
| Временная недоступность PostgreSQL | PASS | Реально закрытый порт → 503 DATABASE_UNAVAILABLE/retryable, ACK отсутствует |
| Receiver flag false | PASS | 503 QR_EVENTS_DISABLED, outbox остаётся failed/nonterminal и успешно повторяется |
| Full app / Swagger / CORS / PIN sessions | PASS | Настоящая сборка всех плагинов, trusted/untrusted origins и authenticated bartender |
| Public snapshot / current round / products | PASS | Local regression и production read-only; 27 production products |
| Health / scheduler / TV pricing | PASS | Health database ok; runtime round transition logs; общие public API проверены. Отдельный визуальный TV-сеанс не проводился |
| iiko read-only | PASS | 55 iiko unit/parser/service проверок; write API не добавлен. Живой внешний iiko запрос не выполнялся |
| Реальный Command Center checkout→outbox→HTTP ACK | PASS | Две отдельные local test DB; настоящий код отправителя и receiver, без mock fetch |
| Production accepted ACK / полный гостевой flow | NOT VERIFIED | Тестовые заказы в production не разрешены сценарием; таких POST не было |
| Production outbox rollout | BLOCKED | Флаг отправителя no; отдельный Hostess BFF configuration blocker отражён в соседнем аудите |

### Результат настоящего межсервисного E2E

`npm run test:command-center-e2e`, сохранённый harness `scripts/command-center-e2e.ts`. Только локальные `xoxo_cross_test` и `command_cross_test`; receiver Prisma и sender SQL migrations разделены. Повторно выполнен с актуальным Command Center main после параллельных исправлений.

Checkout создал 1 anonymous order, 1 accepted outbox line. При выключенном receiver доставка failed/nonterminal; после включения receiver sender получил HTTP 200 с **accepted=true и совпадающим eventId**, затем записал delivered. Повтор той же строки: снова matching ACK, event count остался 1. Настоящая cancel-операция создала второй event; cancellation delivered; QR net units=0; цена исходного раунда 1590.00 не изменилась. Итог: **2 unique events, 2 delivered outbox rows, 1 duplicate, 0 net units**. Это изолированное доказательство ACK, не production-статистика.

## Безопасное включение

1. Доставить проверенный main; дождаться GitHub CI SUCCESS и Railway deployment нужного SHA. Pre-deploy должен завершиться безопасным migration no-op.
2. Проверить health и public snapshot, затем authenticated diagnostics: enabled=true. Проверить CORS для hostes.online и сохранённого биржевого frontend. Receiver rollout сам по себе не создаёт спроса.
3. Повторно подтвердить равенство service keys и sender EXCHANGE_API_ORIGIN. Проверить пустой/согласованный backlog; terminal events не скрывать.
4. После устранения Hostess BFF blocker и согласования запуска со стороной Command Center включить **только там** DINE_IN_OUTBOX_ENABLED=yes и дождаться нового процесса worker. Этим аудитом sender не включён.
5. По обозначенному владельцем production-сценарию проверить первую покупку: eventId/orderItemId → matching receiver ACK → outbox delivered → diagnostics quantities/revenue, без повторного ручного ввода. Аналогично проверить отмену. До этого live readiness не объявлять READY.
6. Откат: receiver flag=false, sender сохраняет retryable outbox. Сохранять additive tables/history; при восстановлении повторять те же event IDs. Не reset/seed/drop production schema.

## Финальная доставка

- Проверенный и развёрнутый SHA: `1d8043785e6051b9d2ecc87fe0f03618d15e0ef7`. Он содержит весь код `aad6b28` и исходный отчёт. Последующее дополнение отчёта не меняет runtime-код.
- [GitHub Actions 38982657288](https://github.com/Su1teen/hostess-XOXO/actions/runs/38982657288): **SUCCESS**, все CI steps пройдены на Linux/Node 22; 217 тестов, schema diff без изменений, повторные миграции no-op.
- Railway deployment **`452858a1-de73-49b1-941d-df39ee271280` SUCCESS**. Pre-deploy `2026-10-16T23:43:51.545Z`: 10 migrations found, **No pending migrations to apply**. Runtime `23:43:59.982Z`: scheduler started, server listening :3000. Production seed/reset отсутствует.
- Read-only post-deploy snapshot **2026-10-16T23:44:42.647Z** (17 октября 04:44 UTC+05): health=ok, database=ok; diagnostics **enabled=true**, events=[], deliveries=0, duplicates=0, rejectedAttempts=0; sender outbox=`no`; ключи по-прежнему совпадают; products/sales API — HTTP 200; snapshot=ok, 27 товаров.
- CORS preflight: `https://hostes.online` → **204**, точный allow-origin; сохранённый биржевой workers.dev → **204**, точный allow-origin; посторонний origin → **404 без allow-origin**. Исходные доверенные адреса не потеряны.
- Живая 15-минутная граница после deployment подтверждена двумя snapshot: 04:30–04:45 раунд `4dd2fe0f-a44f-45c8-b153-b608d0dca721`; затем `2026-10-16T23:45:36.494Z` → новый **PUBLISHED 04:45–05:00**, `9e6105c1-d901-4b06-9055-de3caa710d1b`. Тестовых sales writes не было.
- Ограниченный запрос Railway HTTP logs за последние 10 минут с status>=500 не вернул записей. Известные startup warnings: npm config production и Fastify FSTDEP023 о disableRequestLogging; это не провал запуска/ingestion. Полную ретеншн-статистику ошибок этим запросом не утверждаем.
- Прямой публичный read-only запрос `https://hostes.online/api/guest/v1/dine-in/menu?venue=xoxo` всё ещё **503 SERVICE_UNAVAILABLE / «Сервис пока не настроен»**. Поэтому общий READY не присваивается, outbox не включается. Дальнейшее действие относится к Hostess BFF rollout и согласованной активации Command Center, а не к изменению ORDER_ACCEPTED/ORDER_CANCELLED.

Значения ключей, токены QR и персональные данные в отчёт не включены. Локальный PostgreSQL этого аудита остановлен; production-процессы вручную не перезапускались.
