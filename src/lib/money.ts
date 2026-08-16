import { Decimal } from 'decimal.js';

// 12 значащих цифр достаточно для тенге; округление «половина вверх» как в кассовой практике.
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = Decimal | number | string;

export function toDecimal(value: MoneyInput): Decimal {
  const decimal = value instanceof Decimal ? value : new Decimal(value.toString());
  if (!decimal.isFinite()) {
    throw new Error('Некорректное денежное значение');
  }
  return decimal;
}

export interface RoundToStepBounds {
  /** Если результат превысит границу — округлять вниз. */
  floorAbove?: MoneyInput | null;
  /** Если результат окажется ниже границы — округлять вверх. */
  ceilBelow?: MoneyInput | null;
}

/** Округляет сумму до ближайшего кратного шага (например, 50 ₸). */
export function roundToStep(
  value: MoneyInput,
  step: MoneyInput,
  bounds: RoundToStepBounds = {},
): Decimal {
  const amount = toDecimal(value);
  const stepDecimal = toDecimal(step);
  if (stepDecimal.lte(0)) {
    throw new Error('Шаг округления должен быть больше нуля');
  }
  const rounded = amount
    .div(stepDecimal)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .mul(stepDecimal);

  if (bounds.floorAbove !== undefined && bounds.floorAbove !== null) {
    const limit = toDecimal(bounds.floorAbove);
    if (rounded.gt(limit)) {
      return amount.div(stepDecimal).toDecimalPlaces(0, Decimal.ROUND_FLOOR).mul(stepDecimal);
    }
  }
  if (bounds.ceilBelow !== undefined && bounds.ceilBelow !== null) {
    const limit = toDecimal(bounds.ceilBelow);
    if (rounded.lt(limit)) {
      return amount.div(stepDecimal).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(stepDecimal);
    }
  }
  return rounded;
}

export function clamp(value: MoneyInput, min: MoneyInput, max: MoneyInput): Decimal {
  const amount = toDecimal(value);
  const minDecimal = toDecimal(min);
  const maxDecimal = toDecimal(max);
  if (minDecimal.gt(maxDecimal)) {
    throw new Error('min не может быть больше max');
  }
  if (amount.lt(minDecimal)) return minDecimal;
  if (amount.gt(maxDecimal)) return maxDecimal;
  return amount;
}

/** Процентное изменение от `from` к `to`, округлённое до 4 знаков. */
export function changePercent(from: MoneyInput, to: MoneyInput): Decimal {
  const fromDecimal = toDecimal(from);
  const toDecimal_ = toDecimal(to);
  if (fromDecimal.isZero()) {
    return toDecimal_.isZero() ? new Decimal(0) : new Decimal(100);
  }
  return toDecimal_.minus(fromDecimal).div(fromDecimal).mul(100).toDecimalPlaces(4);
}

export function applyPercent(value: MoneyInput, percent: MoneyInput): Decimal {
  return toDecimal(value).mul(toDecimal(percent).div(100));
}

/** Нормализует сумму к 2 знакам (формат хранения Decimal(12,2)). */
export function toMoney(value: MoneyInput): Decimal {
  return toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** Число для JSON-ответов. Для тенге безопасно: суммы кратны шагу и невелики. */
export function toNumber(value: MoneyInput): number {
  return toMoney(value).toNumber();
}

export function isNonNegative(value: MoneyInput): boolean {
  return toDecimal(value).gte(0);
}

export { Decimal };
