import { describe, expect, it } from 'vitest';
import { getCurrentRound, getNextRound, getPreparationTime, getRoundKey } from '../src/lib/time.js';
import { canTransition } from '../src/modules/rounds/rounds.service.js';

const TZ = 'Asia/Almaty';

describe('окна 15-минутных раундов', () => {
  it('getCurrentRound округляет вниз до 15 минут', () => {
    const window = getCurrentRound('2026-08-16T20:22:31', TZ, 15);
    expect(getRoundKey(window.startsAt, TZ, 15)).toBe('2026-08-16-20-15-Asia-Almaty');
    expect(window.endsAt.getTime() - window.startsAt.getTime()).toBe(15 * 60 * 1000);
    expect(window.timezone).toBe(TZ);
  });

  it('getNextRound даёт следующее окно', () => {
    const next = getNextRound('2026-08-16T20:22:31', TZ, 15);
    expect(getRoundKey(next.startsAt, TZ, 15)).toBe('2026-08-16-20-30-Asia-Almaty');
  });

  it('переход через час и через сутки корректен', () => {
    expect(getRoundKey(getNextRound('2026-08-16T20:59:59', TZ, 15).startsAt, TZ, 15)).toBe(
      '2026-08-16-21-00-Asia-Almaty',
    );
    expect(getRoundKey(getNextRound('2026-08-16T23:50:00', TZ, 15).startsAt, TZ, 15)).toBe(
      '2026-08-17-00-00-Asia-Almaty',
    );
  });

  it('ключ раунда стабилен для любого момента внутри окна', () => {
    expect(getRoundKey('2026-08-16T20:15:00', TZ, 15)).toBe(
      getRoundKey('2026-08-16T20:29:59', TZ, 15),
    );
  });

  it('getPreparationTime отсчитывает минуты до начала', () => {
    const next = getNextRound('2026-08-16T20:22:31', TZ, 15);
    const preparation = getPreparationTime(next, 3);
    expect(next.startsAt.getTime() - preparation.getTime()).toBe(3 * 60 * 1000);
  });

  it('одно и то же окно в разных таймзонах даёт разные ключи', () => {
    expect(getRoundKey('2026-08-16T20:22:31Z', TZ, 15)).not.toBe(
      getRoundKey('2026-08-16T20:22:31Z', 'UTC', 15),
    );
  });
});

describe('переходы статусов раунда', () => {
  it('разрешает штатный жизненный цикл', () => {
    expect(canTransition('SIMULATED', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'PUBLISHED')).toBe(true);
    expect(canTransition('PUBLISHED', 'ROLLED_BACK')).toBe(true);
  });

  it('запрещает недопустимые переходы', () => {
    expect(canTransition('SIMULATED', 'PUBLISHED')).toBe(false);
    expect(canTransition('PUBLISHED', 'APPROVED')).toBe(false);
    expect(canTransition('ROLLED_BACK', 'PUBLISHED')).toBe(false);
    expect(canTransition('CANCELLED', 'SIMULATED')).toBe(false);
  });
});
