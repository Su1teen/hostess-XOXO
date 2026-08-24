import {
  CURRENCY,
  DEMAND_SCORE_MAX,
  DEMAND_SCORE_MIN,
  FALLBACK_RANGE_PERCENT,
  K_DEMAND_SENSITIVITY,
  PRICE_ALGORITHM_VERSION,
} from '../config/constants.js';
import { validationError } from '../lib/errors.js';
import {
  Decimal,
  MoneyInput,
  applyPercent,
  changePercent,
  clamp,
  roundToStep,
  toDecimal,
  toMoney,
} from '../lib/money.js';

export function calculateDemandScore(quantity: MoneyInput, average: MoneyInput): Decimal {
  const sales = toDecimal(quantity);
  const avg = toDecimal(average);
  if (avg.isZero()) return new Decimal(0);
  return sales.minus(avg).div(Decimal.max(avg, 1)).clamp(-1, 1);
}

/** Минимальное количество продаж, при котором спрос считается активным. */
export const EXCHANGE_MIN_SALES_FOR_DEMAND = 2;

export const PRICE_LEVELS = [-30, -20, -10, 0, 10, 20, 30, 40, 50, 60, 70] as const;
export type PriceLevelPercent = (typeof PRICE_LEVELS)[number];

export function normalizePriceLevelPercent(value: unknown): PriceLevelPercent {
  if (typeof value !== 'number' || !Number.isInteger(value) || !PRICE_LEVELS.includes(value as PriceLevelPercent)) {
    throw validationError('priceLevelPercent должен быть одним из уровней -30..70 с шагом 10');
  }
  return value as PriceLevelPercent;
}

/**
 * Каноническая ставка биржи: всегда считается относительно originalPrice.
 *
 * Формула фактического изменения:
 *   actualPercent = ((currentPrice - originalPrice) / originalPrice) * 100
 *
 * Правила:
 * 1. Выбирает ближайший уровень из PRICE_LEVELS.
 * 2. Никогда не меняет знак на противоположный:
 *    - actualPercent < 0 → результат ≤ 0;
 *    - actualPercent > 0 → результат ≥ 0;
 *    - actualPercent = 0 → результат = 0.
 * 3. При выходе ниже -30 возвращает -30 (hard floor).
 * 4. При выходе выше +70 возвращает +70 (hard ceiling).
 * 5. При равном расстоянии приоритет у нижнего/дисконтного уровня.
 *
 * Знак НЕ определяется через minPrice, previousPrice, roundChangePercent
 * или абсолютную разницу currentPrice - minPrice.
 */
export function getCanonicalPriceLevelPercent(request: {
  originalPrice: MoneyInput;
  currentPrice: MoneyInput;
}): PriceLevelPercent {
  const original = toDecimal(request.originalPrice);
  if (original.isZero()) return 0;
  const actual = toDecimal(request.currentPrice).minus(original).div(original).mul(100);

  // Фильтруем уровни по знаку: если actual < 0, исключаем положительные;
  // если actual > 0, исключаем отрицательные; если actual = 0, оставляем только 0.
  const sign = actual.comparedTo(0);
  const candidates = PRICE_LEVELS.filter((level) => {
    if (sign < 0) return level <= 0;
    if (sign > 0) return level >= 0;
    return level === 0;
  });

  // Выбираем ближайший уровень; при равном расстоянии приоритет у меньшего (дисконтного).
  // candidates всегда содержит хотя бы один элемент (0 входит во все ветви фильтра).
  const initial: PriceLevelPercent = candidates[0] ?? 0;
  return candidates.reduce((nearest, level) => {
    const distance = actual.minus(level).abs();
    const nearestDistance = actual.minus(nearest).abs();
    // lt (строго меньше) сохраняет приоритет первого встречного — меньшего уровня.
    return distance.lt(nearestDistance) ? level : nearest;
  }, initial);
}

/** @deprecated Используйте getCanonicalPriceLevelPercent. */
export const getPriceLevelPercent = getCanonicalPriceLevelPercent;

export function calculatePriceFromLevel(request: {
  originalPrice: MoneyInput;
  minPrice: MoneyInput;
  maxPrice: MoneyInput;
  priceStep: MoneyInput;
  priceLevelPercent: number;
}): Decimal {
  const level = normalizePriceLevelPercent(request.priceLevelPercent);
  const original = toMoney(request.originalPrice);
  const minPrice = toMoney(request.minPrice);
  const maxPrice = toMoney(request.maxPrice);
  const rawPrice = original.mul(new Decimal(1).plus(new Decimal(level).div(100)));
  return toMoney(clamp(roundToStep(rawPrice, request.priceStep), minPrice, maxPrice));
}

/**
 * Спрос биржи за раунд.
 *
 * Q_i < 2                 -> 0 (нет активного спроса, цена не меняется)
 * иначе clamp((Q_i - Q_avg) / max(Q_avg, 1), 0, 1)
 *
 * Отрицательного спроса нет: отсутствие продаж не опускает цену ниже текущей.
 */
export function calculateExchangeDemandScore(quantity: MoneyInput, average: MoneyInput): Decimal {
  const sales = toDecimal(quantity);
  if (sales.lt(EXCHANGE_MIN_SALES_FOR_DEMAND)) return new Decimal(0);
  const avg = toDecimal(average);
  return sales.minus(avg).div(Decimal.max(avg, 1)).clamp(0, 1);
}

export function calculatePriceLevelDelta(quantity: MoneyInput, average: MoneyInput): 0 | 10 | 20 | 30 {
  const sales = toDecimal(quantity);
  if (sales.lt(EXCHANGE_MIN_SALES_FOR_DEMAND)) return 0;
  const ratio = sales.div(Decimal.max(toDecimal(average), 1));
  if (ratio.lt(1)) return 0;
  if (ratio.lt(1.5)) return 10;
  if (ratio.lt(2)) return 20;
  return 30;
}

export interface PriceCalculationRequest {
  productId: string;
  productName: string;
  currentPrice: MoneyInput;
  basePrice: MoneyInput;
  minPrice?: MoneyInput | null;
  maxPrice?: MoneyInput | null;
  priceStep: MoneyInput;
  maxChangePercent: MoneyInput;
  demandScore?: MoneyInput | null;
  salesQuantity?: MoneyInput | null;
  /** Коэффициент чувствительности; по умолчанию K_DEMAND_SENSITIVITY. */
  k?: MoneyInput;
}

export interface PriceCalculationInput {
  algorithmVersion: string;
  currency: string;
  productId: string;
  productName: string;
  currentPrice: string;
  basePrice: string;
  minPrice: string;
  maxPrice: string;
  priceStep: string;
  maxChangePercent: string;
  demandScore: string;
  salesQuantity: string;
  k: string;
  fallbackRangeUsed: boolean;
}

export interface PriceCalculationResult {
  algorithmVersion: string;
  currency: string;
  /** Цена до ограничений: currentPrice * (1 + k * demandScore) */
  rawPrice: string;
  /** После округления до шага. */
  roundedPrice: string;
  /** После ограничения maxChangePercent. */
  changeLimitedPrice: string;
  /** Итог после clamp(min, max) и повторного округления до шага. */
  finalPrice: string;
  changePercent: string;
  clampedByMin: boolean;
  clampedByMax: boolean;
  clampedByMaxChangePercent: boolean;
  warnings: string[];
}

export interface PriceCalculation {
  productId: string;
  previousPrice: Decimal;
  calculatedPrice: Decimal;
  minPrice: Decimal;
  maxPrice: Decimal;
  priceStep: Decimal;
  demandScore: Decimal;
  salesQuantity: Decimal;
  changePercent: Decimal;
  input: PriceCalculationInput;
  result: PriceCalculationResult;
}

/**
 * Детерминированный расчёт цены следующего раунда.
 *
 * nextPrice = clamp(roundToStep(currentPrice * (1 + k * demandScore), step), min, max)
 * с дополнительным ограничением |change| <= maxChangePercent.
 *
 * Функция чистая: никакой БД, никакого iiko, никакой случайности.
 */
export function calculateNextPrice(request: PriceCalculationRequest): PriceCalculation {
  const warnings: string[] = [];

  const basePrice = toMoney(request.basePrice);
  const currentPriceRaw = toDecimal(request.currentPrice ?? basePrice);
  const currentPrice = toMoney(currentPriceRaw.isZero() ? basePrice : currentPriceRaw);
  const priceStep = toMoney(request.priceStep);
  const maxChangePercent = toDecimal(request.maxChangePercent);
  const k = toDecimal(request.k ?? K_DEMAND_SENSITIVITY);

  if (currentPrice.lte(0)) {
    throw validationError(
      `Некорректные настройки цены товара «${request.productName}»: текущая цена должна быть больше нуля`,
      { productId: request.productId },
    );
  }
  if (priceStep.lte(0)) {
    throw validationError(
      `Некорректные настройки цены товара «${request.productName}»: шаг округления должен быть больше нуля`,
      { productId: request.productId },
    );
  }
  if (maxChangePercent.lt(0)) {
    throw validationError(
      `Некорректные настройки цены товара «${request.productName}»: maxChangePercent не может быть отрицательным`,
      { productId: request.productId },
    );
  }

  const demandScore = toDecimal(request.demandScore ?? 0);
  if (demandScore.lt(DEMAND_SCORE_MIN) || demandScore.gt(DEMAND_SCORE_MAX)) {
    throw validationError(
      `demandScore должен быть в диапазоне [${DEMAND_SCORE_MIN}, ${DEMAND_SCORE_MAX}]`,
      { productId: request.productId },
    );
  }
  const salesQuantity = toDecimal(request.salesQuantity ?? 0);

  let fallbackRangeUsed = false;
  let minPrice: Decimal;
  let maxPrice: Decimal;

  if (request.minPrice === null || request.minPrice === undefined) {
    fallbackRangeUsed = true;
    minPrice = toMoney(basePrice.minus(applyPercent(basePrice, FALLBACK_RANGE_PERCENT)));
    warnings.push(
      `minPrice не задан: использован fallback от basePrice (-${FALLBACK_RANGE_PERCENT}%)`,
    );
  } else {
    minPrice = toMoney(request.minPrice);
  }

  if (request.maxPrice === null || request.maxPrice === undefined) {
    fallbackRangeUsed = true;
    maxPrice = toMoney(basePrice.plus(applyPercent(basePrice, FALLBACK_RANGE_PERCENT)));
    warnings.push(
      `maxPrice не задан: использован fallback от basePrice (+${FALLBACK_RANGE_PERCENT}%)`,
    );
  } else {
    maxPrice = toMoney(request.maxPrice);
  }

  if (minPrice.lt(0)) {
    throw validationError(
      `Некорректные настройки цены товара «${request.productName}»: minPrice не может быть отрицательным`,
      { productId: request.productId },
    );
  }
  if (minPrice.gt(maxPrice)) {
    throw validationError(
      `Некорректные настройки цены товара «${request.productName}»: minPrice больше maxPrice`,
      { productId: request.productId },
    );
  }

  const rawPrice = currentPrice.mul(new Decimal(1).plus(k.mul(demandScore)));
  const roundedPrice = toMoney(roundToStep(rawPrice, priceStep));

  const maxAllowedByChange = toMoney(
    currentPrice.plus(applyPercent(currentPrice, maxChangePercent)),
  );
  const minAllowedByChange = toMoney(
    currentPrice.minus(applyPercent(currentPrice, maxChangePercent)),
  );
  const changeLimitedPrice = toMoney(clamp(roundedPrice, minAllowedByChange, maxAllowedByChange));
  const clampedByMaxChangePercent = !changeLimitedPrice.eq(roundedPrice);

  // Границы товара имеют приоритет над ограничением шага изменения.
  const clampedToRange = toMoney(clamp(changeLimitedPrice, minPrice, maxPrice));
  // Округление до шага не должно выводить цену за пределы maxChangePercent,
  // поэтому за границей коридора шаг берётся внутрь него.
  const steppedFinal = toMoney(
    roundToStep(clampedToRange, priceStep, {
      floorAbove: maxAllowedByChange,
      ceilBelow: minAllowedByChange,
    }),
  );
  const finalPrice = toMoney(clamp(steppedFinal, minPrice, maxPrice));

  if (finalPrice.lt(0)) {
    throw validationError('Расчётная цена не может быть отрицательной', {
      productId: request.productId,
    });
  }

  const clampedByMin = finalPrice.eq(minPrice) && changeLimitedPrice.lt(minPrice);
  const clampedByMax = finalPrice.eq(maxPrice) && changeLimitedPrice.gt(maxPrice);
  if (clampedByMaxChangePercent) {
    warnings.push(`Изменение ограничено maxChangePercent = ${maxChangePercent.toString()}%`);
  }
  if (clampedByMin) warnings.push('Цена ограничена снизу minPrice');
  if (clampedByMax) warnings.push('Цена ограничена сверху maxPrice');

  const resultChangePercent = changePercent(currentPrice, finalPrice);

  const input: PriceCalculationInput = {
    algorithmVersion: PRICE_ALGORITHM_VERSION,
    currency: CURRENCY,
    productId: request.productId,
    productName: request.productName,
    currentPrice: currentPrice.toString(),
    basePrice: basePrice.toString(),
    minPrice: minPrice.toString(),
    maxPrice: maxPrice.toString(),
    priceStep: priceStep.toString(),
    maxChangePercent: maxChangePercent.toString(),
    demandScore: demandScore.toString(),
    salesQuantity: salesQuantity.toString(),
    k: k.toString(),
    fallbackRangeUsed,
  };

  const result: PriceCalculationResult = {
    algorithmVersion: PRICE_ALGORITHM_VERSION,
    currency: CURRENCY,
    rawPrice: toMoney(rawPrice).toString(),
    roundedPrice: roundedPrice.toString(),
    changeLimitedPrice: changeLimitedPrice.toString(),
    finalPrice: finalPrice.toString(),
    changePercent: resultChangePercent.toString(),
    clampedByMin,
    clampedByMax,
    clampedByMaxChangePercent,
    warnings,
  };

  return {
    productId: request.productId,
    previousPrice: currentPrice,
    calculatedPrice: finalPrice,
    minPrice,
    maxPrice,
    priceStep,
    demandScore,
    salesQuantity,
    changePercent: resultChangePercent,
    input,
    result,
  };
}
