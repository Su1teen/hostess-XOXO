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

      const [
        organization,
        counts,
        publishedRound,
        simulatedRound,
        lastSyncAt,
        lastSyncSummary,
        lastWebhook,
      ] = await Promise.all([
        app.prisma.organization.findFirst({ where: { isSelected: true } }),
        app.services.products.counts(),
        app.services.rounds.getCurrentPublishedRound(),
        app.services.rounds.getLatestSimulatedRound(),
        app.services.iikoSync.getLastMenuSyncAt(),
        app.services.iikoSync.getLastMenuSyncSummary(),
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
          authBaseUrl: app.env.IIKO_AUTH_BASE_URL,
          menuBaseUrl: app.env.IIKO_MENU_BASE_URL,
          syncEnabled: app.env.IIKO_SYNC_ENABLED,
          apiKey: maskPresence(app.env.IIKO_API_KEY),
          authApiKeyField: app.env.IIKO_AUTH_API_KEY_FIELD,
          appId: maskPresence(app.env.IIKO_APP_ID),
          clientSecret: maskPresence(app.env.IIKO_CLIENT_SECRET),
          authPath: app.env.IIKO_AUTH_PATH,
          menuByIdPath: app.env.IIKO_MENU_BY_ID_PATH,
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
        exchange: {
          total: await app.prisma.exchangeProduct.count(),
          active: await app.prisma.exchangeProduct.count({ where: { isActive: true } }),
          currentRound: publishedRound
            ? {
                id: publishedRound.id,
                roundKey: publishedRound.roundKey,
                priceItemCount: publishedRound.prices.filter((item) => item.exchangeProductId)
                  .length,
              }
            : null,
          nextRound: nextRound.roundKey,
          scheduler: {
            intervalMinutes: interval,
            timezone,
            running: !(await app.services.exchange.isPaused()),
            inProcess: app.roundScheduler ?? { enabled: false, schedule: null, timezone },
          },
          lastTransition: app.services.rounds.getTransitionState(),
          paused: await app.services.exchange.isPaused(),
          initialization: {
            expectedProducts: 27,
            complete: (await app.prisma.exchangeProduct.count()) === 27,
          },
        },
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
          lastSummary: lastSyncSummary,
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

  /**
   * Состояние раундов и последнего перехода: чтобы понять «почему цена не изменилась»
   * без доступа к БД. Гостевой API этого не отдаёт — только админ по x-admin-api-key.
   */
  app.get(
    `${API_PREFIX}/admin/exchange/round-state`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Admin Diagnostics'],
        summary: 'Состояние активного раунда, продаж и последнего перехода',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => {
      const now = new Date();
      const timezone = app.env.APP_TIMEZONE;
      const interval = app.env.PRICE_ROUND_INTERVAL_MINUTES;
      const activeRound = await app.services.exchange.getActiveRound();
      const sales = activeRound
        ? await app.prisma.exchangeSale.groupBy({
            by: ['exchangeProductId'],
            where: { roundId: activeRound.id, exchangeProductId: { not: null } },
            _sum: { quantity: true },
          })
        : [];

      return {
        serverNow: now.toISOString(),
        timezone,
        serverTimezoneOffsetMinutes: -now.getTimezoneOffset(),
        currentWindow: serializeWindow(getCurrentRound(now, timezone, interval)),
        activeRound: activeRound
          ? {
              id: activeRound.id,
              roundKey: activeRound.roundKey,
              status: activeRound.status,
              startsAt: activeRound.startsAt.toISOString(),
              endsAt: activeRound.endsAt.toISOString(),
              timezone: activeRound.timezone,
              organizationId: activeRound.organizationId,
              salesQuantityTotal: sales.reduce((sum, row) => sum + (row._sum.quantity ?? 0), 0),
              salesByProduct: sales.map((row) => ({
                productId: row.exchangeProductId,
                quantity: row._sum.quantity ?? 0,
              })),
            }
          : null,
        scheduler: app.roundScheduler ?? { enabled: false, schedule: null, timezone },
        paused: await app.services.exchange.isPaused(),
        lastTransition: app.services.rounds.getTransitionState(),
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
          'Выполняет две независимые стадии: (1) POST {IIKO_AUTH_BASE_URL}/access_token и (2) при успехе — ' +
          'POST {IIKO_MENU_BASE_URL}/menu с Bearer-токеном. Возвращает только безопасные факты: итоговые URL, ' +
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
