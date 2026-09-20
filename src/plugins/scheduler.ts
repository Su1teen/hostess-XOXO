import fp from 'fastify-plugin';
import cron from 'node-cron';
import { sanitizeMessage } from '../lib/redaction.js';

/**
 * Внутренний планировщик переходов раундов внутри web-процесса.
 *
 * Раньше переход выполнялся только внешним Railway Cron Service; если он не был
 * настроен, раунды закрывались «сами» через carry-over в ExchangeService и продажи
 * никогда не влияли на цену. Планировщик проверяет границу раунда каждую минуту:
 * transitionRound идемпотентен (advisory lock + признак завершённого раунда),
 * поэтому параллельный внешний cron безопасен.
 */
export const schedulerPlugin = fp(async (app) => {
  if (!app.env.ROUND_SCHEDULER_ENABLED) {
    app.log.warn(
      { event: 'round_scheduler_disabled' },
      'внутренний планировщик раундов отключён (ROUND_SCHEDULER_ENABLED=false)',
    );
    return;
  }

  const logger = app.log.child({ component: 'round-scheduler' });

  const runTransition = async (trigger: 'boot' | 'tick'): Promise<void> => {
    try {
      if (await app.services.exchange.isPaused()) return;
      const round = await app.services.rounds.transitionRound();
      if (round) {
        logger.debug(
          { event: 'round_scheduler_tick', trigger, roundKey: round.roundKey },
          'планировщик проверил границу раунда',
        );
      }
    } catch (error) {
      logger.error(
        {
          event: 'round_scheduler_failed',
          trigger,
          message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
        },
        'ошибка планировщика раундов',
      );
    }
  };

  const task = cron.schedule(
    '* * * * *',
    () => {
      void runTransition('tick');
    },
    { timezone: app.env.APP_TIMEZONE },
  );

  app.addHook('onReady', async () => {
    logger.info(
      {
        event: 'round_scheduler_started',
        intervalMinutes: app.env.PRICE_ROUND_INTERVAL_MINUTES,
        timezone: app.env.APP_TIMEZONE,
      },
      'внутренний планировщик раундов запущен',
    );
    // Догоняем окно, пропущенное во время простоя/деплоя.
    void runTransition('boot');
  });

  app.addHook('onClose', async () => {
    task.stop();
  });

  app.decorate('roundScheduler', {
    enabled: true,
    schedule: '* * * * *',
    timezone: app.env.APP_TIMEZONE,
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    roundScheduler?: { enabled: boolean; schedule: string; timezone: string };
  }
}
