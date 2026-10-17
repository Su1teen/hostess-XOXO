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
      exchange: { ensureCurrentRound: vi.fn(async () => null) },
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
      exchange: { ensureCurrentRound: vi.fn(async () => null) },
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

// Guest read path must never start a price-writing job.
describe('read-only guest snapshot', () => {
  it.each(['snapshot', 'current-round', 'rounds/current', 'prices', 'products'])('does not advance a round through %s', async (path) => {
    const app = fastify();
    const advance = vi.fn();
    app.decorate('env', env as never);
    app.decorate('services', {
      rounds: { getCurrentPublishedRound: vi.fn(async () => null) },
      exchange: { ensureCurrentRound: advance },
    } as never);
    app.decorate('prisma', { exchangeProduct: { findMany: vi.fn(async () => []) } } as never);
    await app.register(publicRoutes);
    const response = await app.inject({ method: 'GET', url: '/api/v1/public/' + path });
    expect(response.statusCode).toBe(200);
    if (path !== 'products') expect(response.json().status).toBe('no_published_round');
    expect(advance).not.toHaveBeenCalled();
    await app.close();
  });
  it.each(['snapshot', 'products'])('keeps the published price and reference amounts on %s after a catalog edit', async (path) => {
    const app = fastify();
    const product = {id:'drink',name:'Drink',category:'Beer',currency:'KZT',originalPrice:4000,currentPrice:3000,minPrice:2500,currentDiscountPercent:25,isActive:true};
    const round = {id:'round',roundKey:'test',startsAt:new Date('2026-10-16T13:00:00Z'),endsAt:new Date('2026-10-16T13:15:00Z'),status:'PUBLISHED',prices:[{
      exchangeProductId:'drink',exchangeProduct:product,publishedPrice:1500,price:1500,originalPrice:2000,minPrice:1400,previousPrice:1600,changePercent:-6.25,
    }]};
    app.decorate('env', env as never);
    app.decorate('services', {rounds:{getCurrentPublishedRound:vi.fn(async()=>round)},exchange:{ensureCurrentRound:vi.fn()}} as never);
    app.decorate('prisma', {exchangeProduct:{findMany:vi.fn(async()=>[product])}} as never);
    await app.register(publicRoutes);
    const response=await app.inject({url:'/api/v1/public/'+path});
    expect(response.statusCode).toBe(200);
    expect(response.json().products[0]).toMatchObject({price:1500,originalPrice:2000,minPrice:1400,discountPercent:25});
    await app.close();
  });
});
