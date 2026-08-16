import type { LoggerOptions } from 'pino';
import type { AppEnv } from '../config/env.js';
import { LOG_REDACT_PATHS } from '../lib/redaction.js';

/** Опции Pino с обязательной redaction секретов. */
export function buildLoggerOptions(env: AppEnv): LoggerOptions {
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
    base: { app: env.APP_NAME },
    serializers: {
      req: (request: { id: string; method: string; url: string }) => ({
        id: request.id,
        method: request.method,
        url: request.url,
      }),
    },
  };

  if (env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,app' },
      },
    };
  }
  return base;
}
