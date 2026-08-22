import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY } from '../../config/constants.js';
import { conflict, validationError } from '../../lib/errors.js';
import { roundToStep, toNumber } from '../../lib/money.js';
import { verifyBartenderPin } from '../../plugins/auth.js';

function discountFromPrice(original: number, price: number): number {
  return original === 0 ? 0 : Number((((original - price) / original) * 100).toFixed(2));
}

function requestedDiscount(value: unknown): number {
  const discount = Number(value);
  if (!Number.isInteger(discount) || discount < 0 || discount > 100 || discount % 5 !== 0) {
    throw validationError('discountPercent должен быть целым числом от 0 до 100 с шагом 5');
  }
  return discount;
}

export async function bartenderRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { pin: string } }>(`${API_PREFIX}/bartender/auth`, { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    if (typeof request.body?.pin !== 'string' || !verifyBartenderPin(request.body.pin as string, app.env)) throw validationError('Неверный PIN');
    return { token: app.createBartenderSession(), expiresInSeconds: 43200 };
  });
  app.post(`${API_PREFIX}/bartender/logout`, { preHandler: app.requireBartender }, async (request) => {
    const token = request.headers['x-bartender-token'];
    app.clearBartenderSession(Array.isArray(token) ? token[0] ?? '' : token ?? '');
    return { ok: true };
  });

  const auth = { preHandler: app.requireBartender };
  app.get(`${API_PREFIX}/bartender/exchange/status`, auth, async () => app.services.exchange.status());
  app.get(`${API_PREFIX}/bartender/exchange/products`, auth, async () => {
    const round = await app.services.rounds.getCurrentPublishedRound();
    const products = await app.prisma.exchangeProduct.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
    const sales = round ? await app.prisma.exchangeSale.findMany({ where: { roundId: round.id, exchangeProductId: { not: null } } }) : [];
    const quantities = new Map<string, number>();
    for (const sale of sales) quantities.set(sale.exchangeProductId!, (quantities.get(sale.exchangeProductId!) ?? 0) + sale.quantity);
    return { round: round ? { id: round.id, startsAt: round.startsAt, endsAt: round.endsAt } : null, products: products.map((product) => ({
      id: product.id, name: product.name, category: product.category, originalPrice: toNumber(product.originalPrice || product.startPrice),
      currentPrice: toNumber(product.currentPrice), effectiveDiscountPercent: toNumber(product.currentDiscountPercent ?? discountFromPrice(toNumber(product.originalPrice || product.startPrice), toNumber(product.currentPrice))), minPrice: toNumber(product.minPrice),
      salesQuantity: quantities.get(product.id) ?? 0, isAvailable: product.isActive, currency: CURRENCY,
    })) };
  });

  app.post<{ Params: { id: string }; Body: { discountPercent: number } }>(`${API_PREFIX}/bartender/exchange/products/:id/price-preview`, auth, async (request) => {
    const discount = requestedDiscount(request.body?.discountPercent);
    const product = await app.prisma.exchangeProduct.findFirst({ where: { id: request.params.id, isActive: true } });
    if (!product) throw validationError('Товар не является активной биржевой позицией');
    const price = roundToStep((product.originalPrice || product.startPrice).mul(1 - discount / 100), product.priceStep).clamp(product.minPrice, product.maxPrice);
    return { productId: product.id, discountPercent: discount, price: toNumber(price), effectiveDiscountPercent: discount, preview: true };
  });

  app.post<{ Params: { id: string }; Body: { discountPercent: number } }>(`${API_PREFIX}/bartender/exchange/products/:id/apply-price`, auth, async (request) => {
    const discount = requestedDiscount(request.body?.discountPercent);
    const result = await app.prisma.$transaction(async (tx) => {
      const product = await tx.exchangeProduct.findFirst({ where: { id: request.params.id, isActive: true } });
      if (!product) throw validationError('Товар не является активной биржевой позицией');
      const original = product.originalPrice || product.startPrice;
      const price = roundToStep(original.mul(1 - discount / 100), product.priceStep).clamp(product.minPrice, product.maxPrice);
      const updated = await tx.exchangeProduct.update({ where: { id: product.id }, data: { currentPrice: price, currentDiscountPercent: discount, actualDiscountPercent: discount } });
      const round = await tx.priceRound.findFirst({ where: { status: 'PUBLISHED', startsAt: { lte: new Date() }, endsAt: { gt: new Date() } }, orderBy: { startsAt: 'desc' } });
      if (round) await tx.roundPrice.updateMany({ where: { roundId: round.id, exchangeProductId: product.id }, data: { price, calculatedPrice: price, publishedPrice: price, selectedDiscountPercent: discount, actualDiscountPercent: discount } });
      return { product, updated, price, round };
    });
    await app.services.audit.log({ action: 'MANUAL_PRICE_APPLIED', actorType: 'SYSTEM', entityType: 'ExchangeProduct', entityId: result.product.id, summary: `Цена товара ${result.product.name} изменена вручную`, metadata: { oldPrice: result.product.currentPrice.toString(), newPrice: result.price.toString(), discountPercent: discount } });
    return { productId: result.updated.id, price: toNumber(result.price), discountPercent: discount, preview: false };
  });

  app.post<{ Params: { id: string }; Body: { quantity: number } }>(`${API_PREFIX}/bartender/exchange/products/:id/sales/increment`, auth, async (request) => {
    const round = await app.services.sales.getActiveRound();
    if (!round) throw conflict('Нет активного раунда');
    const sale = await app.services.sales.increment(round.id, request.params.id, request.body?.quantity);
    return { productId: request.params.id, roundId: round.id, quantity: sale.quantity, priceAtSale: toNumber(sale.priceAtSale), discountPercentAtSale: toNumber(sale.selectedDiscountPercentAtSale), roundEndsAt: round.endsAt.toISOString() };
  });
  app.post<{ Params: { id: string }; Body: { quantity: number } }>(`${API_PREFIX}/bartender/exchange/products/:id/sales/decrement`, auth, async (request) => {
    const round = await app.services.sales.getActiveRound();
    if (!round) throw conflict('Нет активного раунда');
    return app.services.sales.decrement(round.id, request.params.id, request.body?.quantity);
  });
}
