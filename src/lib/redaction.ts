/** Пути Pino, значения которых заменяются на [REDACTED]. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-admin-api-key"]',
  'req.headers["x-plugin-secret"]',
  'req.headers["x-iiko-signature"]',
  'res.headers["set-cookie"]',
  'apiKey',
  'apiLogin',
  'appId',
  'clientSecret',
  'token',
  'accessToken',
  'password',
  'secret',
  'DATABASE_URL',
  'databaseUrl',
  'IIKO_API_KEY',
  'IIKO_APP_ID',
  'IIKO_CLIENT_SECRET',
  'ADMIN_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'FRONT_PLUGIN_SHARED_SECRET',
  '*.apiKey',
  '*.apiLogin',
  '*.appId',
  '*.clientSecret',
  '*.token',
  '*.accessToken',
  '*.password',
  '*.secret',
];

const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|api[-_]?login|app[-_]?id|client[-_]?secret|token|secret|password|authorization|database_url|connection[-_]?string)/i;

const MAX_DEPTH = 6;

/** Рекурсивно заменяет значения чувствительных ключей на [REDACTED]. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactDeep(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactDeep(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** Маскирует значение, оставляя только длину — для диагностики «задан/не задан». */
export function maskPresence(value: string | undefined | null): string {
  if (!value) return 'not_set';
  return `set(${value.length})`;
}

/** Короткий вид UUID для UI: 8 первых символов. */
export function shortId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

/** Убирает из строки всё похожее на секреты (для сообщений об ошибках в логах). */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, 'postgresql://[REDACTED]')
    .replace(/(bot)?\d{6,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/([a-z0-9_-]*(?:key|token|secret)[a-z0-9_-]*\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}
