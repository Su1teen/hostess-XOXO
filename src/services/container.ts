import type { PrismaClient } from '@prisma/client';
import type { AppEnv } from '../config/env.js';
import { IikoSyncService } from '../modules/iiko/iiko.service.js';
import { ProductsService } from '../modules/products/products.service.js';
import { RoundsService } from '../modules/rounds/rounds.service.js';
import { AuditService } from './audit.service.js';
import { IikoClient, type IikoLogger } from './iiko-client.service.js';
import { createPricePublisher, type PricePublisher } from './price-publisher.service.js';
import { TelegramService } from './telegram.service.js';

export interface AppServices {
  audit: AuditService;
  iikoClient: IikoClient;
  iikoSync: IikoSyncService;
  telegram: TelegramService;
  products: ProductsService;
  rounds: RoundsService;
  pricePublisher: PricePublisher;
}

export interface ContainerLogger extends IikoLogger {
  child(bindings: Record<string, unknown>): ContainerLogger;
}

export function createServices(
  prisma: PrismaClient,
  env: AppEnv,
  logger: ContainerLogger,
): AppServices {
  const audit = new AuditService(prisma, logger);

  const telegram = new TelegramService({
    enabled: env.TELEGRAM_ENABLED,
    botToken: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_ALERT_CHAT_ID,
    cooldownSeconds: env.TELEGRAM_ALERT_COOLDOWN_SECONDS,
    timeoutMs: 10_000,
    logger,
    audit,
  });

  const iikoClient = new IikoClient({
    baseUrl: env.IIKO_API_BASE_URL,
    apiKey: env.IIKO_API_KEY,
    appId: env.IIKO_APP_ID,
    clientSecret: env.IIKO_CLIENT_SECRET,
    authPath: env.IIKO_AUTH_PATH,
    menuPath: env.IIKO_MENU_PATH,
    authReturnAdditionalInfo: env.IIKO_AUTH_RETURN_ADDITIONAL_INFO,
    authIncludeDisabled: env.IIKO_AUTH_INCLUDE_DISABLED,
    externalMenuId: env.IIKO_EXTERNAL_MENU_ID,
    organizationId: env.IIKO_ORGANIZATION_ID,
    timeoutMs: env.IIKO_REQUEST_TIMEOUT_MS,
    syncEnabled: env.IIKO_SYNC_ENABLED,
    debugRawPayloads: env.IIKO_DEBUG_RAW_PAYLOADS,
    logger: logger.child({ component: 'iiko-client' }),
    onAttempt: (attempt) => audit.recordIikoAttempt(attempt),
  });

  const products = new ProductsService(prisma, audit);
  const rounds = new RoundsService(prisma, env, audit);
  const iikoSync = new IikoSyncService(prisma, env, iikoClient, audit, telegram);
  const pricePublisher = createPricePublisher(env, rounds);

  return { audit, iikoClient, iikoSync, telegram, products, rounds, pricePublisher };
}
