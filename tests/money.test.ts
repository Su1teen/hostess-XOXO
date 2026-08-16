import { describe, expect, it } from 'vitest';
import {
  applyPercent,
  changePercent,
  clamp,
  roundToStep,
  toMoney,
  toNumber,
} from '../src/lib/money.js';

describe('roundToStep', () => {
  it('округляет до ближайшего кратного шага', () => {
    expect(roundToStep(3123, 50).toString()).toBe('3100');
    expect(roundToStep(3126, 50).toString()).toBe('3150');
  });

  it('округляет половину вверх', () => {
    expect(roundToStep(3125, 50).toString()).toBe('3150');
  });

  it('не меняет значение, уже кратное шагу', () => {
    expect(roundToStep(3100, 50).toString()).toBe('3100');
  });

  it('требует положительный шаг', () => {
    expect(() => roundToStep(100, 0)).toThrow();
    expect(() => roundToStep(100, -50)).toThrow();
  });
});

describe('clamp', () => {
  it('ограничивает значение диапазоном', () => {
    expect(clamp(10, 20, 30).toString()).toBe('20');
    expect(clamp(40, 20, 30).toString()).toBe('30');
    expect(clamp(25, 20, 30).toString()).toBe('25');
  });

  it('не допускает min > max', () => {
    expect(() => clamp(25, 30, 20)).toThrow();
  });
});

describe('changePercent', () => {
  it('считает процент изменения', () => {
    expect(changePercent(2900, 3100).toNumber()).toBeCloseTo(6.8966, 4);
    expect(changePercent(3000, 2700).toNumber()).toBeCloseTo(-10, 4);
    expect(changePercent(3000, 3000).toNumber()).toBe(0);
  });

  it('обрабатывает нулевую базу без деления на ноль', () => {
    expect(changePercent(0, 0).toNumber()).toBe(0);
    expect(changePercent(0, 100).toNumber()).toBe(100);
  });
});

describe('applyPercent / toMoney / toNumber', () => {
  it('вычисляет процент от суммы', () => {
    expect(applyPercent(3000, 10).toString()).toBe('300');
  });

  it('нормализует к двум знакам', () => {
    expect(toMoney('3100.005').toString()).toBe('3100.01');
    expect(toNumber('3100.004')).toBe(3100);
  });

  it('отклоняет некорректные значения', () => {
    expect(() => toMoney('не число')).toThrow();
  });
});
