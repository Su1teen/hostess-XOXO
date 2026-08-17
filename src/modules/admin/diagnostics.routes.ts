import type { FastifyInstance } from 'fastify';
import { API_PREFIX, PRICE_ALGORITHM_VERSION } from '../../config/constants.js';
import { maskPresence } from '../../lib/redaction.js';
import { getCurrentRound, getNextRound, getPreparationTime } from '../../lib/time.js';

/**
 * Диагностика для администратора. Возвращает только факт наличия секретов
 * (`set(N)` / `not_set`), но никогда сами значения.
 */
export async function diagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    `${API_PREFIX}/admin/diagnostics`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Admin Diagnostics'],
        summary: 'Сводная диагностика системы',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => {
      const timezone = app.env.APP_TIMEZONE;
      const interval = app.env.PRICE_ROUND_INTERVAL_MINUTES;

      let database: 'ok' | 'unavailable' = 'ok';
      try {
        await app.prisma.$queryRaw`SELECT 1`;
      } catch {
        database = 'unavailable';
      }

      const [organization, counts, publishedRound, simulatedRound, lastSyncAt, lastWebhook] =
        await Promise.all([
          app.prisma.organization.findFirst({ where: { isSelected: true } }),
          app.services.products.counts(),
          app.services.rounds.getCurrentPublishedRound(),
          app.services.rounds.getLatestSimulatedRound(),
          app.services.iikoSync.getLastMenuSyncAt(),
          app.prisma.salesEvent.findFirst({ orderBy: { receivedAt: 'desc' } }),
        ]);

      const nextRound = getNextRound(new Date(), timezone, interval);

      return {
        generatedAt: new Date().toISOString(),
        app: {
          name: app.env.APP_NAME,
          version: '0.1.0',
          environment: app.env.NODE_ENV,
          timezone,
          uptimeSeconds: Math.round(process.uptime()),
          algorithmVersion: PRICE_ALGORITHM_VERSION,
        },
        checks: {
          api: 'ok',
          database,
          iiko: app.services.iikoClient.isConfigured ? 'configured' : 'not_configured',
        },
        iiko: {
          baseUrl: app.env.IIKO_API_BASE_URL,
          syncEnabled: app.env.IIKO_SYNC_ENABLED,
          apiKey: maskPresence(app.env.IIKO_API_KEY),
          appId: maskPresence(app.env.IIKO_APP_ID),
          clientSecret: maskPresence(app.env.IIKO_CLIENT_SECRET),
          authPath: app.env.IIKO_AUTH_PATH,
          organizationIdFromEnv: maskPresence(app.env.IIKO_ORGANIZATION_ID),
          externalMenuIdFromEnv: maskPresence(app.env.IIKO_EXTERNAL_MENU_ID),
          terminalGroupIdFromEnv: maskPresence(app.env.IIKO_TERMINAL_GROUP_ID),
          debugRawPayloads: app.env.IIKO_DEBUG_RAW_PAYLOADS,
          writeOperations: 'disabled_in_v0.1',
        },
        organization: organization
          ? {
              id: organization.id,
              name: organization.name,
              iikoOrganizationId: organization.iikoOrganizationId,
              status: organization.status,
            }
          : null,
        products: counts,
        rounds: {
          currentWindow: serializeWindow(getCurrentRound(new Date(), timezone, interval)),
          nextWindow: serializeWindow(nextRound),
          preparationAt: getPreparationTime(
            nextRound,
            app.env.PRICE_ROUND_PREPARE_MINUTES_BEFORE,
          ).toISOString(),
          publishedRound: publishedRound
            ? {
                id: publishedRound.id,
                roundKey: publishedRound.roundKey,
                startsAt: publishedRound.startsAt.toISOString(),
                endsAt: publishedRound.endsAt.toISOString(),
                status: publishedRound.status,
                productsCount: publishedRound.prices.length,
              }
            : null,
          nextSimulatedRound: simulatedRound
            ? {
                id: simulatedRound.id,
                roundKey: simulatedRound.roundKey,
                startsAt: simulatedRound.startsAt.toISOString(),
                status: simulatedRound.status,
              }
            : null,
        },
        sync: {
          lastMenuSyncAt: lastSyncAt,
        },
        webhook: {
          secretConfigured: maskPresence(app.env.IIKO_WEBHOOK_SECRET) !== 'not_set',
          publicUrlConfigured: maskPresence(app.env.IIKO_WEBHOOK_URL) !== 'not_set',
          lastEventReceivedAt: lastWebhook?.receivedAt.toISOString() ?? null,
        },
        telegram: {
          enabled: app.env.TELEGRAM_ENABLED,
          configured: app.services.telegram.isConfigured,
          cooldownSeconds: app.env.TELEGRAM_ALERT_COOLDOWN_SECONDS,
        },
        frontPlugin: {
          enabled: app.env.FRONT_PLUGIN_ENABLED,
          allowedTerminalsCount: app.env.FRONT_PLUGIN_ALLOWED_TERMINAL_IDS.length,
        },
        pricePublisher: {
          mode: app.services.pricePublisher.mode,
          maxChangePercentDefault: app.env.PRICE_MAX_CHANGE_PERCENT,
          defaultStep: app.env.PRICE_DEFAULT_STEP,
          roundIntervalMinutes: interval,
        },
      };
    },
  );

  app.get(
    `${API_PREFIX}/admin/iiko/auth-diagnostics`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Admin Diagnostics'],
        summary: 'Двухстадийная диагностика iiko: auth + menu (без раскрытия секретов)',
        description:
          'Выполняет две независимые стадии: (1) POST /api/v2/access_token и (2) при успехе — ' +
          'POST /api/v2/menu с Bearer-токеном. Возвращает только безопасные факты: итоговые URL, ' +
          'метод, факты настройки учётных данных, upstream HTTP-статус и correlationId для каждой ' +
          'стадии, безопасное сообщение об ошибке. Ошибки меню отмечаются отдельно и никогда не ' +
          'маскируются под IIKO_AUTH_FAILED. Значения секретов, apiLogin, токена и тела запроса ' +
          'никогда не возвращаются.',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => app.services.iikoClient.diagnoseAuth(),
  );
}

function serializeWindow(window: {
  startsAt: Date;
  endsAt: Date;
  roundKey: string;
  timezone: string;
}) {
  return {
    roundKey: window.roundKey,
    startsAt: window.startsAt.toISOString(),
    endsAt: window.endsAt.toISOString(),
    timezone: window.timezone,
  };
}
