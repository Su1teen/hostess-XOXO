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
            currentDiscountPercent: 31.5625,
            isActive: true,
          },
        ]),
      },
    } as never);
    await app.register(publicRoutes);

    const response = await app.inject({ method: 'GET', url: '/api/v1/public/products' });
    expect(response.statusCode).toBe(200);
    expect(response.json().products).toEqual([
      expect.objectContaining({ id: 'exchange', name: 'Gin Tonic' }),
    ]);
    expect(response.json().products).toHaveLength(1);
    await app.close();
  });
});
