import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeCompare } from '../../lib/idempotency.js';
import { unauthorized, validationError } from '../../lib/errors.js';

export async function commandCenterRoutes(app: FastifyInstance) {
  const auth = {
    preHandler: async (request: { headers: Record<string, string | string[] | undefined> }) => {
      const key = request.headers['x-command-center-key'];
      if (
        typeof key !== 'string' ||
        !app.env.COMMAND_CENTER_SERVICE_KEY ||
        !safeCompare(key, app.env.COMMAND_CENTER_SERVICE_KEY)
      )
        throw unauthorized();
    },
  };
  const map = (p: Awaited<ReturnType<typeof app.prisma.exchangeProduct.findMany>>[number]) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    volumeMl: p.volumeMl,
    currency: p.currency,
    originalPrice: Number(p.originalPrice),
    startPrice: Number(p.startPrice),
    currentPrice: Number(p.currentPrice),
    minPrice: Number(p.minPrice),
    maxPrice: Number(p.maxPrice),
    priceStep: Number(p.priceStep),
    priceLevelPercent: p.priceLevelPercent,
    isActive: p.isActive,
    imageUrl: null,
    updatedAt: p.updatedAt.toISOString(),
  });
  app.get('/api/v1/command-center/products', auth, async () =>
    (
      await app.prisma.exchangeProduct.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] })
    ).map(map),
  );
  app.patch<{ Params: { id: string } }>(
    '/api/v1/command-center/products/:id',
    auth,
    async (request) => {
      const id = z.string().uuid().parse(request.params.id);
      const parsed = z
        .object({
          minPrice: z.number().finite().nonnegative(),
          maxPrice: z.number().finite().nonnegative(),
          priceStep: z.number().finite().positive(),
          isActive: z.boolean(),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success || parsed.data.minPrice > parsed.data.maxPrice)
        throw validationError('Проверьте коридор цен');
      const rawActor = request.headers['x-staff-actor'];
      const actor = typeof rawActor === 'string' ? rawActor.slice(0, 100) : 'command-center';
      const product = await app.prisma.$transaction(async (tx) => {
        // Ownership is explicit: settings only; never rewrite round/current prices here.
        const updated = await tx.exchangeProduct.update({ where: { id }, data: parsed.data });
        await tx.auditLog.create({
          data: {
            action: 'ADMIN_ACTION',
            actorType: 'command_center_staff',
            actorId: actor,
            entityType: 'exchange_product',
            entityId: id,
            summary: 'Command Center price corridor updated',
            metadata: parsed.data,
          },
        });
        return updated;
      });
      return map(product);
    },
  );
  app.get<{ Querystring: { filter?: string } }>(
    '/api/v1/command-center/sales',
    auth,
    async (request) => {
      const filter = z.enum(['all', 'alcohol', 'kitchen']).parse(request.query.filter ?? 'all');
      const key = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Almaty',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const start = new Date(`${key}T00:00:00+05:00`),
        end = new Date(start.getTime() + 86400000);
      const sales =
        filter === 'kitchen'
          ? []
          : await app.prisma.exchangeSale.findMany({
              where: { round: { startsAt: { gte: start, lt: end } } },
              include: { round: true, exchangeProduct: true, product: true },
            });
      let cents = 0,
        quantity = 0;
      const byHour = new Map<number, { cents: number; items: number }>(),
        categories = new Map<string, { cents: number; items: number }>(),
        top = new Map<
          string,
          { name: string; category: string; quantity: number; cents: number }
        >();
      for (const sale of sales) {
        const revenue = Math.round(Number(sale.priceAtSale) * 100) * sale.quantity;
        const category =
          sale.exchangeProduct?.category ?? sale.product?.categoryName ?? 'Без категории';
        const name = sale.exchangeProduct?.name ?? sale.product?.displayName ?? 'Позиция биржи';
        const hour = Number(
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Almaty',
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(sale.round.startsAt),
        );
        cents += revenue;
        quantity += sale.quantity;
        const h = byHour.get(hour) ?? { cents: 0, items: 0 };
        h.cents += revenue;
        h.items += sale.quantity;
        byHour.set(hour, h);
        const c = categories.get(category) ?? { cents: 0, items: 0 };
        c.cents += revenue;
        c.items += sale.quantity;
        categories.set(category, c);
        const t = top.get(name) ?? { name, category, quantity: 0, cents: 0 };
        t.quantity += sale.quantity;
        t.cents += revenue;
        top.set(name, t);
      }
      return {
        kpis: {
          revenue: cents / 100,
          itemsSold: quantity,
          alcoholRevenue: cents / 100,
          ordersCount: sales.length,
          averageCheck: sales.length ? cents / 100 / sales.length : null,
        },
        hourly: [...byHour]
          .sort(([a], [b]) => a - b)
          .map(([hour, v]) => ({
            hour,
            label: `${String(hour).padStart(2, '0')}:00`,
            revenue: v.cents / 100,
            items: v.items,
          })),
        categories: [...categories].map(([category, v]) => ({
          category,
          revenue: v.cents / 100,
          items: v.items,
          share: cents ? v.cents / cents : 0,
        })),
        top: [...top.values()]
          .sort((a, b) => b.cents - a.cents)
          .slice(0, 10)
          .map((v) => ({
            name: v.name,
            category: v.category,
            isAlcohol: true,
            quantity: v.quantity,
            revenue: v.cents / 100,
            source: 'exchange',
          })),
        sources: { exchangeLines: sales.length, iikoEvents: 0, iikoEventsWithoutPrice: 0 },
        generatedAt: new Date().toISOString(),
        dateLabel: new Intl.DateTimeFormat('ru-RU', {
          timeZone: 'Asia/Almaty',
          day: 'numeric',
          month: 'long',
        }).format(start),
        timezone: 'Asia/Almaty',
      };
    },
  );
}
