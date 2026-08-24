import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import {
  calculateDemandScore,
  calculateNextPrice,
  calculatePriceFromLevel,
  calculatePriceLevelDelta,
  normalizePriceLevelPercent,
  PRICE_LEVELS,
} from '../src/services/price-engine.service.js';

function request(overrides: Partial<Parameters<typeof calculateNextPrice>[0]> = {}) {
  return calculateNextPrice({
    productId: 'p1',
    productName: 'Gin Tonic',
    currentPrice: 3000,
    basePrice: 3000,
    minPrice: 2000,
    maxPrice: 4000,
    priceStep: 50,
    maxChangePercent: 10,
    demandScore: 0,
    salesQuantity: 0,
    ...overrides,
  });
}

describe('дискретные уровни цены', () => {
  it('принимает только уровни от -30 до +70 с шагом 10', () => {
    expect(PRICE_LEVELS).toEqual([-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70]);
    for (const level of PRICE_LEVELS) {
      expect(normalizePriceLevelPercent(level)).toBe(level);
      expect(calculatePriceFromLevel({ originalPrice: 1450, minPrice: 990, maxPrice: 2200, priceStep: 50, priceLevelPercent: level })).toBeDefined();
    }
    for (const level of [-35, 5, 15, 80, 10.5]) {
      expect(() => calculatePriceFromLevel({ originalPrice: 1450, minPrice: 990, maxPrice: 2200, priceStep: 50, priceLevelPercent: level })).toThrow(AppError);
    }
  });

  it('использует minPrice как hard floor и maxPrice как ceiling', () => {
    expect(calculatePriceFromLevel({ originalPrice: 1450, minPrice: 1000, maxPrice: 2200, priceStep: 50, priceLevelPercent: -30 }).toString()).toBe('1000');
    expect(calculatePriceFromLevel({ originalPrice: 1450, minPrice: 990, maxPrice: 2000, priceStep: 50, priceLevelPercent: 70 }).toString()).toBe('2000');
  });

  it('переходит с -30 на -20 после подтверждённого спроса', () => {
    const currentLevel = -30;
    const nextLevel = currentLevel + calculatePriceLevelDelta(2, 2);
    expect(nextLevel).toBe(-20);
    expect(calculatePriceFromLevel({ originalPrice: 1000, minPrice: 700, maxPrice: 2000, priceStep: 50, priceLevelPercent: currentLevel }).toString()).toBe('700');
    expect(calculatePriceFromLevel({ originalPrice: 1000, minPrice: 700, maxPrice: 2000, priceStep: 50, priceLevelPercent: nextLevel }).toString()).toBe('800');
  });

  it('расчитывает рост уровнями по подтверждённому спросу', () => {
    expect(calculatePriceLevelDelta(1, 1)).toBe(0);
    expect(calculatePriceLevelDelta(2, 2)).toBe(10);
    expect(calculatePriceLevelDelta(3, 2)).toBe(20);
    expect(calculatePriceLevelDelta(4, 2)).toBe(30);
    expect(calculatePriceLevelDelta(1, 0)).toBe(0);
  });
});

describe('calculateDemandScore', () => {
  it('считает относительный спрос и clamp-ит его', () => {
    expect(calculateDemandScore(4, 2).toNumber()).toBe(1);
    expect(calculateDemandScore(1, 2).toNumber()).toBe(-0.5);
    expect(calculateDemandScore(4, 0).toNumber()).toBe(0);
  });
});

describe('calculateNextPrice', () => {
  it('нулевой спрос не меняет цену', () => {
    const calculation = request({ demandScore: 0 });
    expect(calculation.calculatedPrice.toString()).toBe('3000');
    expect(calculation.changePercent.toNumber()).toBe(0);
  });

  it('округляет результат до шага 50 ₸', () => {
    // 3000 * (1 + 0.2 * 0.1) = 3060 -> шаг 50 -> 3050
    const calculation = request({ demandScore: 0.1 });
    expect(calculation.calculatedPrice.toString()).toBe('3050');
    expect(Number(calculation.calculatedPrice.toString()) % 50).toBe(0);
  });

  it('не поднимает цену выше maxPrice', () => {
    const calculation = request({ currentPrice: 3950, maxPrice: 4000, demandScore: 1 });
    expect(calculation.calculatedPrice.toString()).toBe('4000');
    expect(calculation.result.clampedByMax).toBe(true);
  });

  it('не опускает цену ниже minPrice', () => {
    const calculation = request({ currentPrice: 2050, minPrice: 2000, demandScore: -1 });
    expect(calculation.calculatedPrice.toString()).toBe('2000');
    expect(calculation.result.clampedByMin).toBe(true);
  });

  it('ограничивает большое изменение maxChangePercent', () => {
    // demandScore = 1 даёт +20%, но maxChangePercent = 10 разрешает только 3300.
    const calculation = request({ demandScore: 1, maxChangePercent: 5 });
    expect(calculation.calculatedPrice.toString()).toBe('3150');
    expect(calculation.result.clampedByMaxChangePercent).toBe(true);
    expect(calculation.changePercent.toNumber()).toBeCloseTo(5, 4);
  });

  it('округление до шага не выводит цену за maxChangePercent', () => {
    // 2900 + 10% = 3190; округление «половина вверх» дало бы 3200 (+10.34%).
    const calculation = request({
      currentPrice: 2900,
      basePrice: 2900,
      maxPrice: 5000,
      demandScore: 1,
      maxChangePercent: 10,
    });
    expect(calculation.calculatedPrice.toString()).toBe('3150');
    expect(calculation.changePercent.toNumber()).toBeLessThanOrEqual(10);
  });

  it('использует fallback-диапазон basePrice ±20%, если min/max не заданы', () => {
    const calculation = request({ minPrice: null, maxPrice: null });
    expect(calculation.minPrice.toString()).toBe('2400');
    expect(calculation.maxPrice.toString()).toBe('3600');
    expect(calculation.input.fallbackRangeUsed).toBe(true);
    expect(calculation.result.warnings.length).toBeGreaterThan(0);
  });

  it('снижает цену при отрицательном спросе', () => {
    // 3000 * (1 - 0.1 * 0.5) = 2850
    const calculation = request({ demandScore: -0.5, maxChangePercent: 20 });
    expect(calculation.calculatedPrice.toString()).toBe('2850');
    expect(calculation.changePercent.toNumber()).toBeCloseTo(-5, 4);
  });

  it('возвращает безопасную ошибку валидации при нулевой цене и базе', () => {
    expect(() => request({ currentPrice: 0, basePrice: 0 })).toThrow(AppError);
    try {
      request({ currentPrice: 0, basePrice: 0 });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION_ERROR');
      expect((error as AppError).statusCode).toBe(400);
    }
  });

  it('отклоняет некорректный шаг и перевёрнутый диапазон', () => {
    expect(() => request({ priceStep: 0 })).toThrow(AppError);
    expect(() => request({ minPrice: 4000, maxPrice: 2000 })).toThrow(AppError);
    expect(() => request({ maxChangePercent: -5 })).toThrow(AppError);
  });

  it('отклоняет demandScore вне диапазона [-1, 1]', () => {
    expect(() => request({ demandScore: 2 })).toThrow(AppError);
    expect(() => request({ demandScore: -2 })).toThrow(AppError);
  });

  it('фиксирует версию алгоритма и валюту в расчёте', () => {
    const calculation = request();
    expect(calculation.input.algorithmVersion).toBe('v0.2-round-demand');
    expect(calculation.result.currency).toBe('KZT');
  });
});
