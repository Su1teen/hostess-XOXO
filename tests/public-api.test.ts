import fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { publicRoutes } from '../src/modules/public-api/public.routes.js';

const env = {
  APP_TIMEZONE: 'Asia/Almaty',
  PRICE_ROUND_INTERVAL_MINUTES: 15,
};

describe('public exchange API', () => {
  it('возвращает только активные биржевые товары', async () => {
    const app = fastify();
    app.decorate('env', env as never);
    app.decorate('services', {
      rounds: { getCurrentPublishedRound: vi.fn(async () => null) },
    } as never);
    app.decorate('prisma', {
      exchangeProduct: {
        findMany: vi.fn(async () => [
          {
            id: 'exchange',
            name: 'Gin Tonic',
            category: 'Коктейли',
            currency: 'KZT',
            originalPrice: 3200,
            currentPrice: 2190,
            minPrice: 2190,
            priceLevelPercent: -30,
            currentDiscountPercent: 31.5625,
            isActive: true,
          },
        ]),
      },
    } as never);
    await app.register(publicRoutes);

    const response = await app.inject({ method: 'GET', url: '/api/v1/public/products' });
    expect(response.statusCode).toBe(200);
    const products = response.json().products;
    expect(products).toHaveLength(1);
    expect(products[0]).toEqual(expect.objectContaining({ id: 'exchange', name: 'Gin Tonic' }));
    expect(products[0].discountPercent).toBe(32);
    expect(products[0].priceLevelPercent).toBe(-30);
    expect(products[0].currentDiscountPercent).toBeUndefined();
    await app.close();
  });

  it('Bud: public API возвращает currentPrice=1550, minPrice=1550, priceLevelPercent=-30', async () => {
    const app = fastify();
    app.decorate('env', env as never);
    app.decorate('services', {
      rounds: { getCurrentPublishedRound: vi.fn(async () => null) },
    } as never);
    app.decorate('prisma', {
      exchangeProduct: {
        findMany: vi.fn(async () => [
          {
            id: 'bud-id',
            name: 'Bud',
            category: 'Бутылочное пиво',
            currency: 'KZT',
            originalPrice: 2190,
            currentPrice: 1550,
            minPrice: 1550,
            priceLevelPercent: -30,
            currentDiscountPercent: 29.2237,
            isActive: true,
          },
        ]),
      },
    } as never);
    await app.register(publicRoutes);

    const response = await app.inject({ method: 'GET', url: '/api/v1/public/products' });
    expect(response.statusCode).toBe(200);
    const product = response.json().products[0];
    expect(product.name).toBe('Bud');
    expect(product.price).toBe(1550);
    expect(product.minPrice).toBe(1550);
    expect(product.originalPrice).toBe(2190);
    expect(product.priceLevelPercent).toBe(-30);
    expect(product.price).not.toBe(990);
    await app.close();
  });
});
