import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Сравнение секретов, устойчивое к timing-атакам. */
export function safeCompare(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Детерминированный ключ события для дедупликации webhook-ов.
 * Если внешний ID отсутствует, считаем хэш от payload — повторная доставка
 * того же тела не создаст дубликат.
 */
export function deriveExternalEventId(payload: unknown, explicitId?: string | null): string {
  if (explicitId && explicitId.trim().length > 0) return explicitId.trim();
  const serialized = stableStringify(payload);
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function newRequestId(): string {
  return randomUUID();
}
