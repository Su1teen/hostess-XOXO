import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';

export interface DiningReadItem {
  id: string; productId: string | null; itemType: 'EXCHANGE' | 'REGULAR_MENU';
  name: string; quantity: number; unitPriceMinor: string; totalMinor: string; roundId: string | null;
}
export interface DiningReadOrder {
  id: string; number: string; tableResourceId: string; tableCode: string; tableName: string;
  zoneName: string; diningSessionId: string; guestId: string | null; guestName: string | null;
  status: string; paymentStatus: string; manualPaymentAt: Date | null; acceptedAt: Date;
  subtotalMinor: string; discountMinor: string; payableMinor: string; cashbackMinor: string;
  cashbackExpiresAt: Date | null; items: DiningReadItem[];
}

/** A narrow, read-only view of CC-owned records. No Prisma model, copy, or writer. */
export class DiningReadService {
  constructor(private readonly prisma: PrismaClient) {}

  private async read<T>(query: Prisma.Sql): Promise<T> {
    try { return await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
      return tx.$queryRaw<T>(query);
    }, { timeout: 5000 }); } catch {
      // A sequential deployment may not yet have CC's tables; never turn this into an empty queue.
      throw new AppError('DATABASE_UNAVAILABLE', 'Данные Command Center временно недоступны. Повторите обновление.', 503);
    }
  }

  async orders(scope: 'active' | 'recent' = 'active') {
    const orders = await this.read<DiningReadOrder[]>(Prisma.sql`
      SELECT o.id, o.number::text, o.table_resource_id AS "tableResourceId", r.code AS "tableCode",
        r.name AS "tableName", z.name AS "zoneName", o.dining_session_id AS "diningSessionId",
        o.guest_id AS "guestId", g.name AS "guestName", o.status, o.payment_status AS "paymentStatus",
        o.manual_payment_at AS "manualPaymentAt", o.accepted_at AS "acceptedAt",
        o.subtotal_minor::text AS "subtotalMinor", o.discount_minor::text AS "discountMinor",
        o.payable_minor::text AS "payableMinor", o.cashback_minor::text AS "cashbackMinor",
        (SELECT l.expires_at FROM loyalty_lots l WHERE l.order_id=o.id) AS "cashbackExpiresAt",
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,
          'productId',COALESCE(i.exchange_product_id,to_jsonb(i)->>'menu_item_id'),
          'itemType',COALESCE(to_jsonb(i)->>'item_type','EXCHANGE'),
          'name',i.name,'quantity',i.quantity,'unitPriceMinor',i.unit_price_minor::text,
          'totalMinor',i.total_minor::text,'roundId',i.round_id) ORDER BY i.id),'[]')
         FROM dine_in_order_items i WHERE i.order_id=o.id AND i.venue_id=o.venue_id) AS items
      FROM dine_in_orders o JOIN hostess_venues v ON v.id=o.venue_id
      JOIN venue_resources r ON r.id=o.table_resource_id AND r.venue_id=o.venue_id
      JOIN venue_zones z ON z.id=r.zone_id LEFT JOIN hostess_guests g ON g.id=o.guest_id
      WHERE v.slug='xoxo' AND (${scope}='recent' OR o.status NOT IN ('closed','cancelled'))
      ORDER BY o.accepted_at DESC,o.id DESC LIMIT 101
    `);
    return { generatedAt: new Date().toISOString(), source: 'command_center', currency: 'KZT',
      scope, hasMore: orders.length > 100, orders: orders.slice(0, 100) };
  }

  async menu() {
    const items = await this.read<Record<string, unknown>[]>(Prisma.sql`
      SELECT i.id,i.name,i.description,i.category,i.image_url AS "imageUrl",i.portion,i.allergens,
        i.price_minor::text AS "priceMinor",i.is_available AS "isAvailable",i.version
      FROM venue_menu_items i JOIN hostess_venues v ON v.id=i.venue_id
      WHERE v.slug='xoxo' AND i.published ORDER BY i.sort_order,i.category,i.name,i.id LIMIT 500
    `);
    return { generatedAt: new Date().toISOString(), source: 'command_center', currency: 'KZT', items };
  }
}
