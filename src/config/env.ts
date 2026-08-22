import { z } from 'zod';

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  })
  .default(false);

const csvList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );

const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    APP_NAME: z.string().default('Bar Exchange Backend'),
    APP_TIMEZONE: z.string().default('Asia/Almaty'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL обязателен'),

    ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY обязателен, минимум 16 символов'),
    ADMIN_API_KEY_HEADER: z.string().default('x-admin-api-key'),
    // Панель бармена: предпочтительно BARTENDER_PIN_HASH (sha256 hex от PIN).
    // BARTENDER_PIN — временный fallback в открытом виде (по умолчанию 1234).
    BARTENDER_PIN_HASH: optionalString,
    BARTENDER_PIN: z.string().default('1234'),
    BARTENDER_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(720),
    BARTENDER_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),
    BARTENDER_LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),

    CORS_ORIGINS: csvList,

    // Auth и полное menu используют РАЗНЫЕ базы iiko Cloud API:
    //   auth: POST {IIKO_AUTH_BASE_URL}{IIKO_AUTH_PATH}
    //   menu: POST {IIKO_MENU_BASE_URL}{IIKO_MENU_BY_ID_PATH}
    IIKO_AUTH_BASE_URL: z.string().url().default('https://api-ru.iiko.services/api/v2'),
    IIKO_MENU_BASE_URL: z.string().url().default('https://api-ru.iiko.services/api/2'),
    IIKO_API_KEY: optionalString,
    IIKO_AUTH_API_KEY_FIELD: z.literal('apiLogin').default('apiLogin'),
    IIKO_APP_ID: optionalString,
    IIKO_CLIENT_SECRET: optionalString,
    IIKO_AUTH_PATH: z.string().default('/access_token'),
    // Полное внешнее меню iiko: POST {IIKO_MENU_BASE_URL}{IIKO_MENU_BY_ID_PATH}
    // -> https://api-ru.iiko.services/api/2/menu/by_id
    IIKO_MENU_BY_ID_PATH: z.string().default('/menu/by_id'),
    IIKO_AUTH_RETURN_ADDITIONAL_INFO: booleanFromString,
    IIKO_AUTH_INCLUDE_DISABLED: booleanFromString,
    IIKO_ORGANIZATION_ID: optionalString,
    IIKO_EXTERNAL_MENU_ID: optionalString,
    IIKO_TERMINAL_GROUP_ID: optionalString,
    IIKO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
    IIKO_SYNC_ENABLED: booleanFromString,
    IIKO_DEBUG_RAW_PAYLOADS: booleanFromString,

    IIKO_WEBHOOK_SECRET: optionalString,
    IIKO_WEBHOOK_URL: optionalString,

    TELEGRAM_ENABLED: booleanFromString,
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_ALERT_CHAT_ID: optionalString,
    TELEGRAM_ALERT_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(86400).default(900),

    FRONT_PLUGIN_ENABLED: booleanFromString,
    FRONT_PLUGIN_SHARED_SECRET: optionalString,
    FRONT_PLUGIN_ALLOWED_TERMINAL_IDS: csvList,

    PRICE_PUBLISHER_MODE: z.enum(['disabled', 'manual', 'front_plugin']).default('disabled'),
    PRICE_ROUND_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    PRICE_ROUND_PREPARE_MINUTES_BEFORE: z.coerce.number().int().min(0).max(60).default(3),
    PRICE_MAX_CHANGE_PERCENT: z.coerce.number().min(0).max(100).default(10),
    PRICE_DEFAULT_STEP: z.coerce.number().min(1).max(100000).default(50),
  })
  .superRefine((value, ctx) => {
    if (value.IIKO_SYNC_ENABLED && !value.IIKO_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IIKO_API_KEY'],
        message: 'IIKO_API_KEY обязателен при IIKO_SYNC_ENABLED=true',
      });
    }
    if (value.IIKO_SYNC_ENABLED && !value.IIKO_APP_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IIKO_APP_ID'],
        message: 'IIKO_APP_ID обязателен при IIKO_SYNC_ENABLED=true',
      });
    }
    if (value.IIKO_SYNC_ENABLED && !value.IIKO_CLIENT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IIKO_CLIENT_SECRET'],
        message: 'IIKO_CLIENT_SECRET обязателен при IIKO_SYNC_ENABLED=true',
      });
    }
    if (value.IIKO_SYNC_ENABLED && !value.IIKO_EXTERNAL_MENU_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IIKO_EXTERNAL_MENU_ID'],
        message: 'IIKO_EXTERNAL_MENU_ID обязателен при IIKO_SYNC_ENABLED=true',
      });
    }
    if (value.IIKO_SYNC_ENABLED && !value.IIKO_ORGANIZATION_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IIKO_ORGANIZATION_ID'],
        message: 'IIKO_ORGANIZATION_ID обязателен при IIKO_SYNC_ENABLED=true',
      });
    }
    if (value.TELEGRAM_ENABLED && (!value.TELEGRAM_BOT_TOKEN || !value.TELEGRAM_ALERT_CHAT_ID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_BOT_TOKEN'],
        message:
          'TELEGRAM_BOT_TOKEN и TELEGRAM_ALERT_CHAT_ID обязательны при TELEGRAM_ENABLED=true',
      });
    }
    if (value.FRONT_PLUGIN_ENABLED && !value.FRONT_PLUGIN_SHARED_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FRONT_PLUGIN_SHARED_SECRET'],
        message: 'FRONT_PLUGIN_SHARED_SECRET обязателен при FRONT_PLUGIN_ENABLED=true',
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Валидирует переменные окружения. Сообщения об ошибках содержат только имена
 * переменных — значения секретов никогда не попадают в вывод.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `- ${issue.path.join('.') || 'ENV'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация окружения:\n${problems}`);
  }
  return result.data;
}

let cached: AppEnv | null = null;

export function getEnv(): AppEnv {
  if (!cached) {
    cached = parseEnv();
  }
  return cached;
}

/** Только для тестов: сбрасывает кэш env. */
export function resetEnvCache(): void {
  cached = null;
}
