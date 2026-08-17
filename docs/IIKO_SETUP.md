# Настройка iiko Cloud

v0.1 использует iiko Cloud **только для чтения**. Никакие заказы, прайс-листы и цены в iiko
не создаются и не изменяются.

## 1. Получите API-логин

1. В iikoWeb (личный кабинет) откройте настройки интеграций и создайте API-ключ для
   iiko Transport / Cloud API.
2. Скопируйте значение — это `IIKO_API_KEY` (в терминологии iiko — `apiLogin`).
3. Ничего не коммитьте: ключ задаётся только переменной окружения.

## 2. Переменные окружения

```env
IIKO_API_BASE_URL=https://api-ru.iiko.services/api/1
IIKO_API_KEY=<apiLogin>
IIKO_APP_ID=<appId>
IIKO_CLIENT_SECRET=<clientSecret>
IIKO_AUTH_PATH=/api/v2/access_token
IIKO_AUTH_RETURN_ADDITIONAL_INFO=false
IIKO_AUTH_INCLUDE_DISABLED=false
IIKO_ORGANIZATION_ID=<uuid, опционально>
IIKO_EXTERNAL_MENU_ID=<externalMenuId, опционально>
IIKO_TERMINAL_GROUP_ID=<uuid, опционально>
IIKO_REQUEST_TIMEOUT_MS=15000
IIKO_SYNC_ENABLED=true
IIKO_DEBUG_RAW_PAYLOADS=false
```

- `IIKO_SYNC_ENABLED=false` полностью отключает обращения к iiko (все iiko-эндпоинты вернут
  `IIKO_NOT_CONFIGURED`) — удобный безопасный режим для демо и разработки.
- `IIKO_DEBUG_RAW_PAYLOADS=true` включает логирование payload-ов **с редакцией**; включайте
  только на время диагностики.
- Авторизация и меню используют iiko Cloud API **v2**: `POST /api/v2/access_token` и
  `POST /api/v2/menu`. Токен живёт только в памяти процесса.

## 3. Используемые эндпоинты (все read-only)

| Операция     | Эндпоинт                                |
| ------------ | --------------------------------------- |
| Токен (v2)   | `POST /api/v2/access_token`             |
| Меню (v2)    | `POST /api/v2/menu`                     |
| Организации  | `POST /api/1/organizations`             |
| Номенклатура | `POST /api/1/nomenclature`              |
| Стоп-листы   | `POST /api/1/stop_lists`                |

Записывающие эндпоинты (заказы, прайс-листы, оплаты) не вызываются — это проверяется тестом
в `tests/iiko-client.test.ts`.

## 4. Порядок первичной настройки

```bash
# 1. Проверка соединения
curl -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/iiko/test-connection

# 2. Синхронизация организаций и выбор активной
curl -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/iiko/sync-organizations
curl -X POST -H "x-admin-api-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"iikoOrganizationId":"<organization uuid>"}' \
  http://localhost:3000/api/v1/admin/iiko/select-organization

# 3. Синхронизация номенклатуры
curl -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/iiko/sync-menu

# 4. Выбор биржевых товаров (вручную, backend не угадывает барные позиции)
curl -H "x-admin-api-key: $ADMIN_API_KEY" \
  'http://localhost:3000/api/v1/admin/products?search=джин'
curl -X POST -H "x-admin-api-key: $ADMIN_API_KEY" \
  http://localhost:3000/api/v1/admin/products/<id>/select-for-exchange
```

То же самое доступно через страницу диагностики `/admin`.

## 5. Webhook продаж (опционально)

```env
IIKO_WEBHOOK_SECRET=<произвольная длинная строка>
IIKO_WEBHOOK_URL=https://<ваш-домен>/api/v1/webhooks/iiko
```

Backend проверяет заголовок `x-iiko-signature`, дедуплицирует события и сохраняет их
в `sales_events`. Сырой payload сохраняется только при `IIKO_DEBUG_RAW_PAYLOADS=true`.

## Диагностика проблем

| Симптом                   | Что проверить                                        |
| ------------------------- | ---------------------------------------------------- |
| `IIKO_NOT_CONFIGURED`     | `IIKO_SYNC_ENABLED=true`, `IIKO_API_KEY`, `IIKO_APP_ID`, `IIKO_CLIENT_SECRET` |
| `IIKO_AUTH_FAILED`        | Корректность apiLogin/appId/clientSecret             |
| `IIKO_REQUEST_FAILED` 4xx | Идентификатор организации, externalMenuId, права ключа |
| Таймауты                  | `IIKO_REQUEST_TIMEOUT_MS`, сетевой доступ из Railway |
| Пустая номенклатура       | Организация выбрана? Меню опубликовано в iiko?       |

Двухстадийная диагностика auth + menu: `GET /api/v1/admin/iiko/auth-diagnostics`
и кнопка «Диагностика авторизации» в `/admin`. Возвращает upstream HTTP-статус и
`correlationId` для каждой стадии, но никогда не раскрывает секреты или токен.

Все попытки обращения к iiko видны в таблице `iiko_sync_attempts` и в `/api/v1/admin/diagnostics`.
