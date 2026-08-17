import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';

interface SelectOrganizationBody {
  iikoOrganizationId: string;
}

export async function iikoRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    `${API_PREFIX}/admin/iiko/test-connection`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Проверить подключение к iiko Cloud API (read-only)',
        security: [{ adminApiKey: [] }],
      },
    },
    async (request) => {
      const result = await app.services.iikoSync.testConnection(request.id);
      return {
        ok: result.ok,
        organizationsCount: result.organizationsCount,
        durationMs: result.durationMs,
      };
    },
  );

  app.post(
    `${API_PREFIX}/admin/iiko/sync-organizations`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Синхронизировать список организаций из iiko',
        security: [{ adminApiKey: [] }],
      },
    },
    async (request) => app.services.iikoSync.syncOrganizations(request.id),
  );

  app.get(
    `${API_PREFIX}/admin/iiko/organizations`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Организации, сохранённые в базе',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => {
      const organizations = await app.services.iikoSync.listOrganizations();
      return {
        items: organizations.map((organization) => ({
          id: organization.id,
          iikoOrganizationId: organization.iikoOrganizationId,
          name: organization.name,
          status: organization.status,
          isSelected: organization.isSelected,
          productsCount: organization._count.products,
          updatedAt: organization.updatedAt.toISOString(),
        })),
      };
    },
  );

  app.post<{ Body: SelectOrganizationBody }>(
    `${API_PREFIX}/admin/iiko/select-organization`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Выбрать единственную рабочую организацию (v0.1)',
        security: [{ adminApiKey: [] }],
        body: {
          type: 'object',
          required: ['iikoOrganizationId'],
          additionalProperties: false,
          properties: {
            iikoOrganizationId: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const organization = await app.services.iikoSync.selectOrganization(
        request.body.iikoOrganizationId,
        request.id,
      );
      return {
        id: organization.id,
        iikoOrganizationId: organization.iikoOrganizationId,
        name: organization.name,
        isSelected: organization.isSelected,
      };
    },
  );

  app.post(
    `${API_PREFIX}/admin/iiko/sync-menu`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Синхронизировать внешнее меню выбранной организации (/api/2/menu/by_id)',
        description:
          'Только чтение из iiko. Извлекаются sellable item-size variants. ' +
          'Пропавшие варианты помечаются недоступными, а не удаляются. ' +
          'Возвращается только сводка — без сырого тела меню.',
        security: [{ adminApiKey: [] }],
      },
    },
    async (request) => app.services.iikoSync.syncMenu(request.id),
  );

  app.post(
    `${API_PREFIX}/admin/iiko/menu-test`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Временно проверить точный read-only запрос POST /api/2/menu/by_id',
        description:
          'Получает свежий token и возвращает только безопасные параметры запроса, upstream status, ' +
          'content-type, correlationId и отредактированный response text (до 1000 символов).',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => app.services.iikoClient.diagnoseMenuRequest(),
  );

  app.post(
    `${API_PREFIX}/admin/iiko/menu-transport-test`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary:
          'Сравнить транспорты fetch и https.request для POST /api/2/menu/by_id (Postman-эквивалент)',
        description:
          'Выполняет fetch первым; если fetch вернул HTML 5xx (Symfony error page), выполняет ' +
          'https.request с теми же URL, заголовками и телом. Возвращает безопасные fingerprints ' +
          'обоих транспортов: outbound header names, User-Agent, content-type, response HTTP status, ' +
          'response content-type, response text SHA-256, response text first 300 chars (redacted), ' +
          'duration, correlationId. Никогда не возвращает токен или секреты.',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => app.services.iikoClient.diagnoseMenuTransport(),
  );

  app.get(
    `${API_PREFIX}/admin/iiko/menu-request-diagnostics`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Безопасная диагностика фактического POST /api/2/menu/by_id',
        description:
          'Получает свежий auth token, выполняет read-only запрос полного меню и возвращает только ' +
          'безопасные fingerprints и отредактированный response text (до 1000 символов).',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => app.services.iikoClient.diagnoseMenuRequest(),
  );

  app.get(
    `${API_PREFIX}/admin/iiko/last-sync-summary`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['iiko'],
        summary: 'Сводка последней синхронизации меню (без сырого тела)',
        security: [{ adminApiKey: [] }],
      },
    },
    async () => app.services.iikoSync.getLastMenuSyncSummary(),
  );
}
