export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  'CONFLICT',
  'DATABASE_UNAVAILABLE',
  'IIKO_NOT_CONFIGURED',
  'IIKO_AUTH_FAILED',
  'IIKO_REQUEST_FAILED',
  'IIKO_MENU_REQUEST_FAILED',
  'IIKO_MENU_NETWORK_ERROR',
  'IIKO_MENU_TIMEOUT',
  'IIKO_MENU_JSON_PARSE_FAILED',
  'IIKO_MENU_PARSER_FAILED',
  'IIKO_MENU_DATABASE_FAILED',
  'IIKO_ORGANIZATION_NOT_SELECTED',
  'NO_EXCHANGE_PRODUCTS_SELECTED',
  'INVALID_ROUND_TRANSITION',
  'ROUND_NOT_FOUND',
  'NO_PUBLISHED_ROUND',
  'PLUGIN_INTEGRATION_DISABLED',
  'TELEGRAM_NOT_CONFIGURED',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

/** Ошибка с безопасным для клиента сообщением. Внутренние детали живут в `details`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;
  readonly exposeDetails: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
    exposeDetails = false,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.exposeDetails = exposeDetails;
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        requestId,
        ...(this.exposeDetails && this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const unauthorized = (message = 'Неверный или отсутствующий ключ доступа') =>
  new AppError('UNAUTHORIZED', message, 401);

export const forbidden = (message = 'Доступ запрещён') => new AppError('FORBIDDEN', message, 403);

export const notFound = (message = 'Объект не найден', code: ErrorCode = 'NOT_FOUND') =>
  new AppError(code, message, 404);

export const validationError = (message: string, details?: Record<string, unknown>) =>
  new AppError('VALIDATION_ERROR', message, 400, details);

export const conflict = (message: string, code: ErrorCode = 'CONFLICT') =>
  new AppError(code, message, 409);

export const iikoNotConfigured = () =>
  new AppError(
    'IIKO_NOT_CONFIGURED',
    'Интеграция с iiko не настроена: включите IIKO_SYNC_ENABLED и задайте IIKO_API_KEY',
    503,
  );

export const iikoAuthFailed = (details?: Record<string, unknown>) =>
  new AppError('IIKO_AUTH_FAILED', 'Не удалось авторизоваться в iiko Cloud API', 502, details);

export const iikoRequestFailed = (details?: Record<string, unknown>) =>
  new AppError('IIKO_REQUEST_FAILED', 'Запрос к iiko Cloud API завершился ошибкой', 502, details);

export const iikoMenuRequestFailed = (details: {
  upstreamStatus?: number | null;
  correlationId?: string | null;
  safeUpstreamError: string;
}) =>
  new AppError(
    'IIKO_MENU_REQUEST_FAILED',
    details.safeUpstreamError,
    502,
    {
      upstreamStatus: details.upstreamStatus ?? null,
      correlationId: details.correlationId ?? null,
      safeUpstreamError: details.safeUpstreamError,
    },
    true,
  );

export const iikoMenuNetworkError = (safeMessage: string) =>
  new AppError('IIKO_MENU_NETWORK_ERROR', safeMessage, 502, { kind: 'NETWORK_ERROR' }, true);

export const iikoMenuTimeout = (safeMessage: string) =>
  new AppError('IIKO_MENU_TIMEOUT', safeMessage, 504, { kind: 'TIMEOUT' }, true);

export const iikoMenuJsonParseFailed = (details: {
  upstreamStatus: number;
  correlationId?: string | null;
  safeMessage: string;
}) =>
  new AppError(
    'IIKO_MENU_JSON_PARSE_FAILED',
    details.safeMessage,
    502,
    {
      kind: 'JSON_PARSE_ERROR',
      upstreamStatus: details.upstreamStatus,
      correlationId: details.correlationId ?? null,
    },
    true,
  );

export const iikoMenuParserFailed = (safeMessage: string) =>
  new AppError('IIKO_MENU_PARSER_FAILED', safeMessage, 500, { kind: 'PARSER_ERROR' }, true);

export const iikoMenuDatabaseFailed = (safeMessage: string) =>
  new AppError('IIKO_MENU_DATABASE_FAILED', safeMessage, 500, { kind: 'DATABASE_ERROR' }, true);

export const organizationNotSelected = () =>
  new AppError(
    'IIKO_ORGANIZATION_NOT_SELECTED',
    'Организация не выбрана. Сначала синхронизируйте организации и выберите одну.',
    409,
  );

export const noExchangeProducts = () =>
  new AppError('NO_EXCHANGE_PRODUCTS_SELECTED', 'Не выбрано ни одного биржевого товара', 409);

export const invalidRoundTransition = (from: string, to: string) =>
  new AppError(
    'INVALID_ROUND_TRANSITION',
    `Недопустимый переход статуса раунда: ${from} -> ${to}`,
    409,
  );

export const roundNotFound = () => new AppError('ROUND_NOT_FOUND', 'Раунд не найден', 404);

export const noPublishedRound = () =>
  new AppError('NO_PUBLISHED_ROUND', 'Нет опубликованного раунда', 404);

export const pluginDisabled = () =>
  new AppError('PLUGIN_INTEGRATION_DISABLED', 'Интеграция iikoFront plugin отключена', 503);

export const telegramNotConfigured = () =>
  new AppError('TELEGRAM_NOT_CONFIGURED', 'Telegram-алерты не настроены', 503);

export const databaseUnavailable = () =>
  new AppError('DATABASE_UNAVAILABLE', 'База данных недоступна', 503);

export const internalError = () => new AppError('INTERNAL_ERROR', 'Внутренняя ошибка сервиса', 500);
