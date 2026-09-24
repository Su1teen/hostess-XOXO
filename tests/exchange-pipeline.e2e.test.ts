/**
 * Сквозной тест конвейера «продажи → переход раунда → цена → публичный API».
 *
 * Требует реальной PostgreSQL 16+ с применёнными миграциями. Запускается только
 * если задан E2E_DATABASE_URL — база ОЧИЩАЕТСЯ, поэтому указывать нужно
 * выделенную тестовую БД, а не dev/prod:
 *
 *   E2E_DATABASE_URL="postgresql://postgres:postgres@localhost:5433/bar_exchange_e2e?schema=public" npm test
 */
import { PrismaClient } from '@prisma/client';
import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { getRoundKey } from '../src/lib/time.js';
import { AuditService } from '../src/services/audit.service.js';
import { BartenderService } from '../src/modules/bartender/bartender.service.js';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';
import { RoundsService } from '../src/modules/rounds/rounds.service.js';
import { publicRoutes } from '../src/modules/public-api/public.routes.js';

const DATABASE_URL = process.env.E2E_DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;

const BUD = {
  slug: 'bud-e2e',
  name: 'Bud',
  category: 'Пиво',
  originalPrice: '2190',
  minPrice: '1550',
  maxPrice: '3300',
  priceStep: '50',
  currentPrice: '1550',
  priceLevelPercent: -30,
};

describeE2E('конвейер биржи: 10 продаж → переход → 1750 ₸ / -20%', () => {
  // describe.skip всё равно вычисляет тело блока, поэтому нужен валидный плейсхолдер.
  const databaseUrl = DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:1/none';
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
    log: ['error'],
  });
  const env = parseEnv({
    DATABASE_URL: databaseUrl,
    ADMIN_API_KEY: '0123456789abcdef',
    APP_TIMEZONE: 'Asia/Almaty',
    PRICE_ROUND_INTERVAL_MINUTES: '15',
  } as NodeJS.ProcessEnv);
  const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
  const audit = new AuditService(prisma, silentLogger);
  const rounds = new RoundsService(prisma, env, audit, silentLogger);
  const exchange = new ExchangeService(prisma, rounds, silentLogger);
  const bartender = new BartenderService(prisma, exchange, audit, silentLogger);

  let organizationId = '';
  let budId = '';
  let expiredCount = 0;

  async function resetDatabase(): Promise<void> {
    expiredCount = 0;
    await prisma.exchangeSale.deleteMany({});
    await prisma.roundPrice.deleteMany({});
    await prisma.priceRound.deleteMany({});
    await prisma.exchangeProduct.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.organization.deleteMany({});

    const organization = await prisma.organization.create({
      data: {
        iikoOrganizationId: 'e2e-org',
        name: 'E2E Bar',
        status: 'ACTIVE',
        isSelected: true,
      },
    });
    organizationId = organization.id;

    const bud = await prisma.exchangeProduct.create({
      data: {
        slug: BUD.slug,
        name: BUD.name,
        category: BUD.category,
        currency: 'KZT',
        originalPrice: BUD.originalPrice,
        startPrice: BUD.minPrice,
        currentPrice: BUD.currentPrice,
        minPrice: BUD.minPrice,
        maxPrice: BUD.maxPrice,
        priceStep: BUD.priceStep,
        priceLevelPercent: BUD.priceLevelPercent,
        currentDiscountPercent: '29.2237',
        actualDiscountPercent: '29.2237',
        isActive: true,
      },
    });
    budId = bud.id;
  }

  /**
   * Сдвигает раунд в прошлое вместе с roundKey: имитирует «раунд полностью
   * закончился, началось новое окно».
   */
  async function expireRound(roundId: string): Promise<void> {
    const round = await prisma.priceRound.findUniqueOrThrow({ where: { id: roundId } });
    expiredCount += 1;
    const shiftMs = expiredCount * 20 * 60 * 1000;
    const startsAt = new Date(round.startsAt.getTime() - shiftMs);
    await prisma.priceRound.update({
      where: { id: roundId },
      data: {
        startsAt,
        endsAt: new Date(round.endsAt.getTime() - shiftMs),
        roundKey: getRoundKey(startsAt, env.APP_TIMEZONE, env.PRICE_ROUND_INTERVAL_MINUTES),
      },
    });
  }

  async function salesTotal(roundId: string, productId: string): Promise<number> {
    const aggregate = await prisma.exchangeSale.aggregate({
      where: { roundId, exchangeProductId: productId },
      _sum: { quantity: true },
    });
    return aggregate._sum.quantity ?? 0;
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('10 инкрементов бармена дают SUM(quantity) = 10 в активном раунде', async () => {
    await resetDatabase();
    const round = await exchange.ensureCurrentRound();
    expect(round).not.toBeNull();

    for (let i = 0; i < 10; i += 1) {
      await bartender.incrementSales(budId, 1);
    }

    expect(await prisma.exchangeSale.count({ where: { roundId: round!.id } })).toBe(1);
    expect(await salesTotal(round!.id, budId)).toBe(10);
  });

  it('переход закрытого раунда переводит Bud с 1550/-30 на 1750/-20', async () => {
    await resetDatabase();
    const closed = await exchange.ensureCurrentRound();
    for (let i = 0; i < 10; i += 1) await bartender.incrementSales(budId, 1);
    expect(await salesTotal(closed!.id, budId)).toBe(10);

    await expireRound(closed!.id);
    // Гостевое чтение после границы раунда не должно «съесть» переход carry-over'ом.
    await exchange.ensureCurrentRound();

    const closedAfter = await prisma.priceRound.findUniqueOrThrow({ where: { id: closed!.id } });
    expect(closedAfter.status).toBe('CLOSED');

    const current = await prisma.priceRound.findFirstOrThrow({
      where: { status: 'PUBLISHED', organizationId },
      orderBy: { startsAt: 'desc' },
      include: { prices: true },
    });
    const item = current.prices.find((price) => price.exchangeProductId === budId);
    expect(item).toBeDefined();
    expect(Number(item!.soldQuantity)).toBe(10);
    expect(Number(item!.salesQuantity)).toBe(10);
    expect(item!.priceLevelPercent).toBe(-20);
    expect(Number(item!.previousPrice)).toBe(1550);
    expect(Number(item!.price)).toBe(1750);

    const product = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: budId } });
    expect(Number(product.currentPrice)).toBe(1750);
    expect(product.priceLevelPercent).toBe(-20);
  });

  it('публичный API отдаёт новую цену и уровень после перехода', async () => {
    await resetDatabase();
    const closed = await exchange.ensureCurrentRound();
    for (let i = 0; i < 10; i += 1) await bartender.incrementSales(budId, 1);
    await expireRound(closed!.id);
    await rounds.transitionRound();

    const app = fastify();
    app.decorate('env', env as never);
    app.decorate('prisma', prisma as never);
    app.decorate('services', { rounds, exchange } as never);
    await app.register(publicRoutes);

    const products = await app.inject({ method: 'GET', url: '/api/v1/public/products' });
    expect(products.statusCode).toBe(200);
    const bud = products.json().products.find((item: { name: string }) => item.name === 'Bud');
    expect(bud.price).toBe(1750);
    expect(bud.previousPrice).toBe(1550);

    const currentRound = await app.inject({ method: 'GET', url: '/api/v1/public/rounds/current' });
    expect(currentRound.statusCode).toBe(200);
    const roundItem = currentRound
      .json()
      .products.find((item: { name: string }) => item.name === 'Bud');
    expect(roundItem.price).toBe(1750);
    expect(roundItem.priceLevelPercent).toBe(-20);
    expect(roundItem.originalPrice).toBe(2190);
    expect(roundItem.minPrice).toBe(1550);

    const nextRound = await app.inject({ method: 'GET', url: '/api/v1/public/rounds/next' });
    expect(nextRound.statusCode).toBe(200);

    await app.close();
  });

  it('повторный переход идемпотентен: цена не растёт дважды', async () => {
    await resetDatabase();
    const closed = await exchange.ensureCurrentRound();
    for (let i = 0; i < 10; i += 1) await bartender.incrementSales(budId, 1);
    await expireRound(closed!.id);

    await rounds.transitionRound();
    await rounds.transitionRound();
    await rounds.transitionRound();

    const product = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: budId } });
    expect(Number(product.currentPrice)).toBe(1750);
    expect(product.priceLevelPercent).toBe(-20);
    expect(await prisma.priceRound.count({ where: { status: 'PUBLISHED' } })).toBe(1);
  });

  it('0 продаж — уровень и цена сохраняются', async () => {
    await resetDatabase();
    const closed = await exchange.ensureCurrentRound();
    await expireRound(closed!.id);
    await rounds.transitionRound();

    const product = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: budId } });
    expect(Number(product.currentPrice)).toBe(1550);
    expect(product.priceLevelPercent).toBe(-30);
  });

  it('1 продажа не подтверждает спрос, 2 — подтверждают', async () => {
    await resetDatabase();
    const first = await exchange.ensureCurrentRound();
    await bartender.incrementSales(budId, 1);
    await expireRound(first!.id);
    await rounds.transitionRound();
    let product = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: budId } });
    expect(product.priceLevelPercent).toBe(-30);
    expect(Number(product.currentPrice)).toBe(1550);

    const second = await prisma.priceRound.findFirstOrThrow({
      where: { status: 'PUBLISHED' },
      orderBy: { startsAt: 'desc' },
    });
    await bartender.setSalesQuantity(budId, 2);
    expect(await salesTotal(second.id, budId)).toBe(2);
    await expireRound(second.id);
    await rounds.transitionRound();
    product = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: budId } });
    expect(product.priceLevelPercent).toBe(-20);
    expect(Number(product.currentPrice)).toBe(1750);
  });

  it('PUT quantity абсолютен: повторный PUT 10 оставляет 10', async () => {
    await resetDatabase();
    const round = await exchange.ensureCurrentRound();
    await bartender.setSalesQuantity(budId, 10);
    await bartender.setSalesQuantity(budId, 10);
    expect(await salesTotal(round!.id, budId)).toBe(10);
  });

  it('несколько товаров: 10 продаж у одного, 0 у остальных', async () => {
    await resetDatabase();
    const other = await prisma.exchangeProduct.create({
      data: {
        slug: 'other-e2e',
        name: 'Other',
        category: 'Пиво',
        currency: 'KZT',
        originalPrice: '2000',
        startPrice: '1400',
        currentPrice: '1400',
        minPrice: '1400',
        maxPrice: '3000',
        priceStep: '50',
        priceLevelPercent: -30,
        currentDiscountPercent: '30',
        actualDiscountPercent: '30',
        isActive: true,
      },
    });
    const closed = await exchange.ensureCurrentRound();
    for (let i = 0; i < 10; i += 1) await bartender.incrementSales(budId, 1);
    await expireRound(closed!.id);
    await rounds.transitionRound();

    const bud = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: budId } });
    const untouched = await prisma.exchangeProduct.findUniqueOrThrow({ where: { id: other.id } });
    expect(bud.priceLevelPercent).toBe(-20);
    expect(Number(bud.currentPrice)).toBe(1750);
    expect(untouched.priceLevelPercent).toBe(-30);
    expect(Number(untouched.currentPrice)).toBe(1400);
  });
});
