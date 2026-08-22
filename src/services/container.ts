import type { PrismaClient } from '@prisma/client';
import type { AppEnv } from '../config/env.js';
import { BartenderService } from '../modules/bartender/bartender.service.js';
import { BartenderSessionService } from '../modules/bartender/bartender.session.js';
import { ExchangeService } from '../modules/exchange/exchange.service.js';
import { IikoSyncService } from '../modules/iiko/iiko.service.js';
import { ProductsService } from '../modules/products/products.service.js';
import { RoundsService } from '../modules/rounds/rounds.service.js';
import { SalesService } from '../modules/sales/sales.service.js';
import { AuditService } from './audit.service.js';
import { IikoClient, type IikoLogger } from './iiko-client.service.js';
import { createPricePublisher, type PricePublisher } from './price-publisher.service.js';
import { TelegramService } from './telegram.service.js';

export interface AppServices {
  audit: AuditService;
  bartender: BartenderService;
  bartenderSessions: BartenderSessionService;
  exchange: ExchangeService;
  iikoClient: IikoClient;
  iikoSync: IikoSyncService;
  telegram: TelegramService;
  products: ProductsService;
  rounds: RoundsService;
  sales: SalesService;
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
    authBaseUrl: env.IIKO_AUTH_BASE_URL,
    menuBaseUrl: env.IIKO_MENU_BASE_URL,
    apiKey: env.IIKO_API_KEY,
    authApiKeyField: env.IIKO_AUTH_API_KEY_FIELD,
    appId: env.IIKO_APP_ID,
    clientSecret: env.IIKO_CLIENT_SECRET,
    authPath: env.IIKO_AUTH_PATH,
    menuPath: env.IIKO_MENU_BY_ID_PATH,
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

  const exchange = new ExchangeService(prisma);
  const bartender = new BartenderService(prisma, exchange, audit);
  const bartenderSessions = new BartenderSessionService({
    pinHash: env.BARTENDER_PIN_HASH,
    pin: env.BARTENDER_PIN,
    sessionTtlMinutes: env.BARTENDER_SESSION_TTL_MINUTES,
    maxAttempts: env.BARTENDER_LOGIN_MAX_ATTEMPTS,
    attemptWindowSeconds: env.BARTENDER_LOGIN_WINDOW_SECONDS,
  });
  const products = new ProductsService(prisma, audit);
  const rounds = new RoundsService(prisma, env, audit);
  const sales = new SalesService(prisma);
  const iikoSync = new IikoSyncService(prisma, env, iikoClient, audit, telegram);
  const pricePublisher = createPricePublisher(env, rounds);

  return {
    audit,
    bartender,
    bartenderSessions,
    exchange,
    iikoClient,
    iikoSync,
    telegram,
    products,
    rounds,
    sales,
    pricePublisher,
  };
}
