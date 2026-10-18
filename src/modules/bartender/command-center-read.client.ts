import { z } from 'zod';
import type { AppEnv } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

const item = z.object({
  id: z.string(),
  productId: z.string().nullable(),
  itemType: z.enum(['EXCHANGE', 'REGULAR_MENU']),
  name: z.string(),
  quantity: z.number().int(),
  unitPriceMinor: z.string(),
  totalMinor: z.string(),
  roundId: z.string().nullable(),
});
const order = z.object({
  id: z.string(),
  number: z.string(),
  tableResourceId: z.string(),
  tableCode: z.string(),
  tableName: z.string(),
  zoneName: z.string(),
  diningSessionId: z.string(),
  guestId: z.string().nullable(),
  guestName: z.string().nullable(),
  status: z.string(),
  paymentStatus: z.string(),
  manualPaymentAt: z.string().nullable(),
  acceptedAt: z.string(),
  subtotalMinor: z.string(),
  discountMinor: z.string(),
  payableMinor: z.string(),
  cashbackMinor: z.string(),
  cashbackExpiresAt: z.string().nullable(),
  items: z.array(item),
});
const ordersResponse = z.object({
  generatedAt: z.string(),
  source: z.literal('command_center'),
  currency: z.literal('KZT'),
  scope: z.enum(['active', 'recent']),
  hasMore: z.boolean(),
  orders: z.array(order),
});
const menuResponse = z.object({
  generatedAt: z.string(),
  source: z.literal('command_center'),
  currency: z.literal('KZT'),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      category: z.string(),
      imageUrl: z.string().nullable(),
      portion: z.string(),
      allergens: z.array(z.string()),
      priceMinor: z.string(),
      isAvailable: z.boolean(),
      version: z.number().int(),
    }),
  ),
});

/** Reads Command Center over its authenticated service boundary, never XOXO's own database. */
export class CommandCenterReadClient {
  constructor(private readonly env: AppEnv) {}

  private async read<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const key = this.env.COMMAND_CENTER_SERVICE_KEY;
    if (!key)
      throw new AppError('DATABASE_UNAVAILABLE', 'Данные Command Center временно недоступны.', 503);
    const url = new URL(this.env.COMMAND_CENTER_READ_ORIGIN);
    if (
      url.protocol !== 'https:' &&
      !(
        this.env.NODE_ENV !== 'production' &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1'].includes(url.hostname)
      )
    )
      throw new AppError('DATABASE_UNAVAILABLE', 'Данные Command Center временно недоступны.', 503);
    try {
      const response = await fetch(new URL(path, url.origin), {
        headers: { 'x-command-center-key': key },
        redirect: 'error',
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok) throw new Error('Command Center read failed');
      return schema.parse(await response.json());
    } catch {
      throw new AppError(
        'DATABASE_UNAVAILABLE',
        'Данные Command Center временно недоступны. Повторите обновление.',
        503,
      );
    }
  }

  orders(scope: 'active' | 'recent' = 'active') {
    return this.read(`/api/service/v1/dine-in/orders?scope=${scope}`, ordersResponse);
  }
  menu() {
    return this.read('/api/service/v1/dine-in/menu', menuResponse);
  }
}
