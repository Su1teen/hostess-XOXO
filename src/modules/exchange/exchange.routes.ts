import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';
export async function exchangeRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: app.requireAdmin, schema: { tags: ['Exchange'], security: [{ adminApiKey: [] }] } };
  app.get(`${API_PREFIX}/admin/exchange/products`, auth, async () => ({ items: await app.prisma.exchangeProduct.findMany({ orderBy: { name: 'asc' } }) }));
  app.get(`${API_PREFIX}/admin/exchange/status`, auth, async () => app.services.exchange.status());
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(`${API_PREFIX}/admin/exchange/products/:id`, auth, async (request) => {
    const body = request.body;
    if (body.minPrice !== undefined && body.maxPrice !== undefined && Number(body.minPrice) > Number(body.maxPrice)) throw new Error('minPrice не может быть больше maxPrice');
    return app.prisma.exchangeProduct.update({ where: { id: request.params.id }, data: {
      name: typeof body.name === 'string' ? body.name : undefined, category: typeof body.category === 'string' ? body.category : undefined,
      startPrice: typeof body.startPrice === 'number' ? body.startPrice : undefined, currentPrice: typeof body.currentPrice === 'number' ? body.currentPrice : undefined,
      minPrice: typeof body.minPrice === 'number' ? body.minPrice : undefined, maxPrice: typeof body.maxPrice === 'number' ? body.maxPrice : undefined,
      priceStep: typeof body.priceStep === 'number' ? body.priceStep : undefined, isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
    } });
  });
  for (const { action, active } of [{ action: 'activate', active: true }, { action: 'deactivate', active: false }]) {
    app.post<{ Params: { id: string } }>(`${API_PREFIX}/admin/exchange/products/:id/${action}`, auth, async (request) => app.prisma.exchangeProduct.update({ where: { id: request.params.id }, data: { isActive: active } }));
  }
  app.post(`${API_PREFIX}/admin/exchange/rounds/run`, auth, async () => {
    const current = await app.services.rounds.getCurrentPublishedRound();
    if (!current) {
      const initial = await app.services.exchange.ensureInitialRound();
      if (initial?.created || (initial?.round && initial.round.endsAt > new Date())) return { created: initial?.created ?? false, round: initial?.round };
    }
    const result = await app.services.rounds.simulateRound({ triggerSource: 'MANUAL', createdBy: 'admin' });
    return { created: result.created, round: result.round };
  });
  app.post(`${API_PREFIX}/admin/exchange/pause`, auth, async () => ({ paused: await app.services.exchange.setPaused(true) }));
  app.post(`${API_PREFIX}/admin/exchange/resume`, auth, async () => ({ paused: await app.services.exchange.setPaused(false) }));
}
