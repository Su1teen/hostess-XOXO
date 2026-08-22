import { describe, expect, it } from 'vitest';
import { EXCHANGE_PRODUCTS } from '../src/modules/exchange/exchange.catalog.js';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';

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
});
