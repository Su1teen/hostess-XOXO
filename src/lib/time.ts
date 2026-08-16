import { DateTime } from 'luxon';

export interface RoundWindow {
  startsAt: Date;
  endsAt: Date;
  roundKey: string;
  timezone: string;
}

function zoned(value: Date | string | DateTime, timezone: string): DateTime {
  if (value instanceof DateTime) return value.setZone(timezone);
  if (typeof value === 'string') {
    const parsed = DateTime.fromISO(value, { zone: timezone });
    if (!parsed.isValid) throw new Error('Некорректная дата');
    return parsed;
  }
  return DateTime.fromJSDate(value, { zone: timezone });
}

/** Ключ раунда, например 2026-08-16-20-15-Asia-Almaty. */
export function getRoundKey(
  datetime: Date | string | DateTime,
  timezone: string,
  intervalMinutes = 15,
): string {
  const local = floorToInterval(zoned(datetime, timezone), intervalMinutes);
  const zoneSlug = timezone.replace(/[/_]/g, '-');
  return `${local.toFormat('yyyy-MM-dd-HH-mm')}-${zoneSlug}`;
}

function floorToInterval(datetime: DateTime, intervalMinutes: number): DateTime {
  const flooredMinute = Math.floor(datetime.minute / intervalMinutes) * intervalMinutes;
  return datetime.set({ minute: flooredMinute, second: 0, millisecond: 0 });
}

/** Текущее 15-минутное окно (например 20:15:00.000 — 20:29:59.999). */
export function getCurrentRound(
  now: Date | string | DateTime,
  timezone: string,
  intervalMinutes = 15,
): RoundWindow {
  const start = floorToInterval(zoned(now, timezone), intervalMinutes);
  const end = start.plus({ minutes: intervalMinutes });
  return {
    startsAt: start.toJSDate(),
    endsAt: end.toJSDate(),
    roundKey: getRoundKey(start, timezone, intervalMinutes),
    timezone,
  };
}

/** Следующее 15-минутное окно после текущего. */
export function getNextRound(
  now: Date | string | DateTime,
  timezone: string,
  intervalMinutes = 15,
): RoundWindow {
  const current = getCurrentRound(now, timezone, intervalMinutes);
  return getCurrentRound(
    DateTime.fromJSDate(current.startsAt, { zone: timezone }).plus({ minutes: intervalMinutes }),
    timezone,
    intervalMinutes,
  );
}

/** Окно раунда, содержащее указанный момент (для явного startsAt из API). */
export function getRoundForInstant(
  instant: Date | string | DateTime,
  timezone: string,
  intervalMinutes = 15,
): RoundWindow {
  return getCurrentRound(instant, timezone, intervalMinutes);
}

/** Момент, когда следует подготовить раунд (за N минут до его начала). */
export function getPreparationTime(nextRound: RoundWindow, minutesBefore: number): Date {
  return DateTime.fromJSDate(nextRound.startsAt, { zone: nextRound.timezone })
    .minus({ minutes: minutesBefore })
    .toJSDate();
}

export function formatLocal(value: Date, timezone: string): string {
  return DateTime.fromJSDate(value, { zone: timezone }).toFormat('yyyy-MM-dd HH:mm:ss');
}

export function nowIso(): string {
  return new Date().toISOString();
}

export { DateTime };
