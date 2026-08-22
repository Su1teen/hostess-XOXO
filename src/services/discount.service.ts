import { validationError } from '../lib/errors.js';
import { Decimal, type MoneyInput, roundToStep, toDecimal, toMoney } from '../lib/money.js';

/** Скидка бармена задаётся шагом 5%. */
export const DISCOUNT_STEP_PERCENT = 5;

/** Рабочие значения скидки в панели: 100% не является рабочей скидкой. */
export const MANUAL_DISCOUNT_OPTIONS: number[] = Array.from(
  { length: 20 },
  (_, index) => index * 5,
);

export interface ManualDiscountRequest {
  /** Цена меню без скидки. */
  originalPrice: MoneyInput;
  /** Абсолютный нижний предел цены. */
  minPrice: MoneyInput;
  priceStep?: MoneyInput;
  selectedDiscountPercent: number;
}

export interface ManualDiscountResult {
  originalPrice: Decimal;
  selectedDiscountPercent: Decimal;
  /** originalPrice * (1 - selected / 100) до округления. */
  rawPrice: Decimal;
  /** rawPrice после округления до шага. */
  roundedPrice: Decimal;
  /** max(roundedPrice, minPrice). */
  finalPrice: Decimal;
  /** Фактическая скидка от originalPrice до finalPrice. */
  actualDiscountPercent: Decimal;
  minPriceApplied: boolean;
  discountAmount: Decimal;
  minPrice: Decimal;
}

/** Фактическая скидка от originalPrice к price, 4 знака (canonical). */
export function calculateDiscountPercent(originalPrice: MoneyInput, price: MoneyInput): Decimal {
  const original = toDecimal(originalPrice);
  if (original.lte(0)) return new Decimal(0);
  return original.minus(toDecimal(price)).div(original).mul(100).toDecimalPlaces(4);
}

export function assertValidDiscountPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw validationError('Скидка должна быть числом');
  }
  if (!Number.isInteger(value)) {
    throw validationError('Скидка должна быть целым числом');
  }
  if (value < 0) throw validationError('Скидка не может быть меньше 0%');
  if (value > 100) throw validationError('Скидка не может быть больше 100%');
  if (value % DISCOUNT_STEP_PERCENT !== 0) {
    throw validationError(`Скидка должна быть кратна ${DISCOUNT_STEP_PERCENT}%`);
  }
  return value;
}

/**
 * Ручная скидка бармена.
 *
 * finalPrice = max(roundToStep(originalPrice * (1 - selected / 100), step), minPrice)
 *
 * Функция чистая: никакой БД и никакой случайности. minPrice — абсолютный предел,
 * поэтому фактическая скидка может быть меньше выбранной.
 */
export function calculateManualDiscount(request: ManualDiscountRequest): ManualDiscountResult {
  const selected = assertValidDiscountPercent(request.selectedDiscountPercent);
  const originalPrice = toMoney(request.originalPrice);
  const minPrice = toMoney(request.minPrice);
  const priceStep = toMoney(request.priceStep ?? 50);

  if (originalPrice.lte(0)) {
    throw validationError('originalPrice должен быть больше нуля');
  }
  if (minPrice.lt(0)) {
    throw validationError('minPrice не может быть отрицательным');
  }
  if (priceStep.lte(0)) {
    throw validationError('Шаг округления должен быть больше нуля');
  }

  const rawPrice = toMoney(originalPrice.mul(new Decimal(1).minus(new Decimal(selected).div(100))));
  const roundedPrice = toMoney(roundToStep(rawPrice, priceStep));
  const finalPrice = toMoney(Decimal.max(roundedPrice, minPrice));

  return {
    originalPrice,
    selectedDiscountPercent: new Decimal(selected),
    rawPrice,
    roundedPrice,
    finalPrice,
    actualDiscountPercent: calculateDiscountPercent(originalPrice, finalPrice),
    minPriceApplied: finalPrice.gt(roundedPrice),
    discountAmount: toMoney(originalPrice.minus(finalPrice)),
    minPrice,
  };
}
