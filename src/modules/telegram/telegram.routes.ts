import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';

export async function telegramRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    `${API_PREFIX}/admin/telegram/test`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Telegram'],
        summary: 'Отправить тестовое сообщение в Telegram',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => {
      let database = 'OK';
      try {
        await app.prisma.$queryRaw`SELECT 1`;
      } catch {
        database = 'FAIL';
      }
      const iikoStatus = app.services.iikoClient.isConfigured ? 'OK' : 'NOT CONFIGURED';

      const text = [
        '✅ Bar Exchange backend подключён.',
        `PostgreSQL: ${database}`,
        `iiko Cloud API: ${iikoStatus}`,
        `Timezone: ${app.env.APP_TIMEZONE}`,
      ].join('\n');

      const result = await app.services.telegram.sendMessage(text);
      return { sent: result.sent, reason: result.reason ?? null };
    },
  );
}
