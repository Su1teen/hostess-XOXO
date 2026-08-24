import { describe, expect, it } from 'vitest';
import { EXCHANGE_PRODUCTS } from '../src/modules/exchange/exchange.catalog.js';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';
import { calculatePriceFromLevel, getCanonicalPriceLevelPercent } from '../src/services/price-engine.service.js';

describe('exchange seed contract', () => {
  it('содержит ровно 27 заданных позиций и не импортирует iiko menu', () => {
    expect(EXCHANGE_PRODUCTS).toHaveLength(27);
    expect(EXCHANGE_PRODUCTS.map((product) => product.slug)).toEqual(expect.arrayContaining([
      'german', 'beefeater', 'jagermeister', 'oakheart', 'bacardi-black', 'ballantines', 'jameson', 'chivas', 'jack-daniels', 'monkey-shoulder', 'absolut', 'nemiroff', 'khortytsa-ice', 'kyzylzhar', 'miller-bottle', 'bud-bottle', 'corona-extra', 'paulaner', 'tsingtao', 'hoegaarden', 'red-bull-vodka', 'red-bull-jager', 'gin-tonic', 'red-bull-whiskey', 'mojito', 'long-island', 'whiskey-sour',
    ]));
  });

  it('использует отдельную модель и идемпотентный upsert', () => {
    expect(ExchangeService.prototype.seedProducts).toBeDefined();
    expect(ExchangeService.prototype.ensureInitialRound).toBeDefined();
  });

  it('Bud: originalPrice=2190, minPrice=1550, startPrice=1550', () => {
    const bud = EXCHANGE_PRODUCTS.find((p) => p.slug === 'bud-bottle');
    expect(bud).toBeDefined();
    expect(bud!.originalPrice).toBe(2190);
    expect(bud!.minPrice).toBe(1550);
    expect(bud!.startPrice).toBe(1550);
  });

  it('Bud: minPrice 1550 — это canonical -30% от originalPrice 2190, округлённое до шага 50', () => {
    const bud = EXCHANGE_PRODUCTS.find((p) => p.slug === 'bud-bottle')!;
    const price = calculatePriceFromLevel({
      originalPrice: bud.originalPrice,
      minPrice: bud.minPrice,
      maxPrice: 3300,
      priceStep: 50,
      priceLevelPercent: -30,
    });
    expect(Number(price.toString())).toBe(1550);
    expect(bud.minPrice).toBe(Number(price.toString()));
  });

  it('Bud: canonical priceLevelPercent = -30 при startPrice = minPrice = 1550', () => {
    const bud = EXCHANGE_PRODUCTS.find((p) => p.slug === 'bud-bottle')!;
    const level = getCanonicalPriceLevelPercent({ originalPrice: bud.originalPrice, currentPrice: bud.startPrice });
    expect(level).toBe(-30);
  });

  it('Bud: minPrice не равно 990 (старое значение)', () => {
    const bud = EXCHANGE_PRODUCTS.find((p) => p.slug === 'bud-bottle')!;
    expect(bud.minPrice).not.toBe(990);
  });
});
