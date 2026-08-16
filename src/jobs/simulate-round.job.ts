import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { pino } from 'pino';
import { TRIGGER_SOURCE } from '../config/constants.js';
import { getEnv } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { buildLoggerOptions } from '../plugins/logger.js';
import { sanitizeMessage } from '../lib/redaction.js';
import { createServices, type ContainerLogger } from '../services/container.js';

/**
 * Симуляция следующего 15-минутного раунда.
 *
 * По умолчанию выполняется один раз и завершается — это режим Railway Cron Service
 * (расписание "каждые 15 минут" задаётся на стороне Railway).
 * С флагом `--watch` (или CRON_LONG_RUNNING=true) процесс живёт постоянно
 * и запускает симуляцию по внутреннему расписанию node-cron.
 */
async function runOnce(): Promise<void> {
  const env = getEnv();
  const logger = pino(buildLoggerOptions(env)).child({ component: 'cron:simulate-round' });
  const prisma = new PrismaClient({ log: ['error'] });

  try {
    await prisma.$connect();
    const services = createServices(prisma, env, logger as unknown as ContainerLogger);

    const result = await services.rounds.simulateRound({
      triggerSource: TRIGGER_SOURCE.CRON,
      createdBy: 'cron',
    });

    logger.info(
      {
        roundKey: result.round.roundKey,
        created: result.created,
        products: result.round.prices.length,
      },
      result.created ? 'раунд симулирован' : 'раунд для этого окна уже существует',
    );
  } catch (error) {
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
    logger.error({ code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' }, message);

    try {
      const services = createServices(prisma, env, logger as unknown as ContainerLogger);
      await services.telegram.sendAlert(
        'CRON_SIMULATION_FAILED',
        `⚠️ Bar Exchange: симуляция раунда не выполнена.\nПричина: ${message}`,
      );
    } catch {
      // Алерт не должен маскировать исходную ошибку.
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

function isWatchMode(): boolean {
  return process.argv.includes('--watch') || process.env.CRON_LONG_RUNNING === 'true';
}

async function main(): Promise<void> {
  if (!isWatchMode()) {
    await runOnce();
    return;
  }

  const env = getEnv();
  const schedule = `*/${env.PRICE_ROUND_INTERVAL_MINUTES} * * * *`;
  const logger = pino(buildLoggerOptions(env)).child({ component: 'cron:scheduler' });
  logger.info({ schedule, timezone: env.APP_TIMEZONE }, 'планировщик раундов запущен');

  cron.schedule(
    schedule,
    () => {
      void runOnce().catch(() => {
        // runOnce уже залогировал ошибку и отправил алерт.
      });
    },
    { timezone: env.APP_TIMEZONE },
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Симуляция раунда завершилась ошибкой: ${sanitizeMessage(message)}\n`);
  process.exit(1);
});
