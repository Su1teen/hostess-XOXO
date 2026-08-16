# Контракт iikoFront plugin (experimental, v0.1)

> **Статус.** В v0.1 backend **не меняет кассовую цену** и не отправляет команды в iikoFront.
> Здесь зафиксирован только контракт: backend сообщает цену опубликованного раунда, а установку
> цены в чеке (`predefinedPrice` или аналог) в будущем выполнит плагин на стороне кассы.
> По умолчанию эндпоинт выключен.

## Включение

```env
FRONT_PLUGIN_ENABLED=true
FRONT_PLUGIN_SHARED_SECRET=<длинный случайный секрет>
FRONT_PLUGIN_ALLOWED_TERMINAL_IDS=<uuid,uuid>   # пусто = любой терминал
```

При `FRONT_PLUGIN_ENABLED=false` любой запрос получает `503`:

```json
{ "statusCode": 503, "code": "PLUGIN_INTEGRATION_DISABLED", "message": "…" }
```

## Запрос

```
POST /api/v1/front-plugin/price-quote
x-plugin-secret: <FRONT_PLUGIN_SHARED_SECRET>
x-request-id: <опционально>
content-type: application/json
```

```json
{
  "organizationId": "iiko organization UUID",
  "terminalId": "iiko terminal UUID",
  "productId": "iiko product UUID",
  "requestedAt": "2026-01-01T12:00:00.000Z"
}
```

## Ответ

```json
{
  "quoteId": "UUID",
  "status": "ok",
  "currency": "KZT",
  "productId": "iiko product UUID",
  "issuedAt": "2026-01-01T12:00:00.100Z",
  "fallbackAllowed": false,
  "roundId": "UUID",
  "roundKey": "2026-01-01-17-00-Asia-Almaty",
  "productName": "Gin Tonic",
  "price": 3100,
  "validFrom": "2026-01-01T12:00:00.000Z",
  "validUntil": "2026-01-01T12:15:00.000Z"
}
```

Возможные значения `status`:

| status                 | Смысл                                        |
| ---------------------- | -------------------------------------------- |
| `ok`                   | Есть цена из опубликованного раунда          |
| `product_not_exchange` | Товар не выбран как биржевой                 |
| `unavailable`          | Товар неактивен или архивирован              |
| `no_active_round`      | Нет опубликованного раунда на текущий момент |

При `status != "ok"` поля цены отсутствуют. `fallbackAllowed: false` означает, что касса должна
использовать собственную (обычную) цену iiko, а не подставлять что-либо самостоятельно.

## Ошибки

| HTTP | code                          | Причина                                    |
| ---- | ----------------------------- | ------------------------------------------ |
| 401  | `UNAUTHORIZED`                | Неверный `x-plugin-secret`                 |
| 403  | `FORBIDDEN`                   | Терминал или организация не разрешены      |
| 422  | `VALIDATION_ERROR`            | Организация не выбрана / некорректное тело |
| 429  | `RATE_LIMITED`                | Превышен лимит (120 запросов/мин)          |
| 503  | `PLUGIN_INTEGRATION_DISABLED` | Интеграция отключена                       |

## Гарантии и границы

- Отдаётся цена **только** из раунда в статусе `PUBLISHED`, окно которого активно сейчас.
- Отдаётся цена **только одного** запрошенного товара; список всех цен плагину недоступен.
- В ответе нет токенов iiko, внутренних заметок, метаданных расчёта и стектрейсов.
- Каждый запрос пишется в `audit_logs` (`PLUGIN_QUOTE_REQUESTED`) с `quoteId` и `terminalId`.
- Секрет сравнивается timing-safe; секрет не логируется.

## Что появится позже

1. Плагин iikoFront, который вызывает `price-quote` при добавлении позиции в чек.
2. Подтверждение фактически применённой цены обратно в backend (для сверки).
3. Только после отдельного согласования — автоматическая публикация прайс-листов в iiko.
