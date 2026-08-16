/** Версия алгоритма расчёта цены. Меняйте при изменении формулы. */
export const PRICE_ALGORITHM_VERSION = 'v0.1-linear-demand';

/**
 * Коэффициент чувствительности цены к спросу.
 * nextPrice = clamp(roundToStep(currentPrice * (1 + K_DEMAND_SENSITIVITY * demandScore), step), min, max)
 *
 * K = 0.2 означает: demandScore = 1.0 даёт +20% до применения ограничений
 * (maxChangePercent и min/max всё равно обрезают результат).
 */
export const K_DEMAND_SENSITIVITY = 0.2;

/** Валюта v0.1. */
export const CURRENCY = 'KZT';

/** Границы demandScore, принимаемые движком. */
export const DEMAND_SCORE_MIN = -1;
export const DEMAND_SCORE_MAX = 1;

/**
 * Fallback safety range v0.1: если у товара не заданы minPrice/maxPrice,
 * используем basePrice ± этот процент и помечаем warning в calculationResult.
 */
export const FALLBACK_RANGE_PERCENT = 20;

export const API_PREFIX = '/api/v1';

export const TRIGGER_SOURCE = {
  CRON: 'CRON',
  MANUAL: 'MANUAL',
  TEST: 'TEST',
} as const;

export const SALES_EVENT_SOURCE_IIKO_WEBHOOK = 'IIKO_WEBHOOK';

export const SWAGGER_TAGS = [
  { name: 'Health', description: 'Проверки живости сервиса' },
  { name: 'Public', description: 'Публичное API для Cloudflare frontend' },
  { name: 'Admin Diagnostics', description: 'Диагностика и статус (требует x-admin-api-key)' },
  { name: 'iiko', description: 'Интеграция с iiko Cloud API (только чтение в v0.1)' },
  { name: 'Products', description: 'Номенклатура и выбор биржевых товаров' },
  { name: 'Rounds', description: '15-минутные ценовые раунды' },
  { name: 'Telegram', description: 'Алерты в Telegram' },
  { name: 'Webhooks', description: 'Приём событий iiko (experimental)' },
  { name: 'Front Plugin', description: 'Контракт для будущего iikoFront plugin (experimental)' },
] as const;
