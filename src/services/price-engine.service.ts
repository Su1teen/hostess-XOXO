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
