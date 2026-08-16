import type { FastifyInstance } from 'fastify';
import { ADMIN_PAGE_HTML } from './admin-page.html.js';

/**
 * Диагностическая страница администратора.
 *
 * HTML отдаётся без каких-либо данных и секретов: ключ вводит администратор,
 * он хранится только в sessionStorage браузера и отправляется в заголовке.
 */
export async function adminPageRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/admin',
    { schema: { hide: true }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const html = ADMIN_PAGE_HTML.replaceAll(
        '__ADMIN_HEADER__',
        app.env.ADMIN_API_KEY_HEADER.toLowerCase(),
      );
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(html);
    },
  );
}
