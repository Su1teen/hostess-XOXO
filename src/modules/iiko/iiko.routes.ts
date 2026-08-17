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
        summary: 'Синхронизировать внешнее меню выбранной организации (/api/2/menu)',
        description:
          'Только чтение из iiko. Извлекаются sellable item-size variants. ' +
          'Пропавшие варианты помечаются недоступными, а не удаляются. ' +
          'Возвращается только сводка — без сырого тела меню.',
        security: [{ adminApiKey: [] }],
      },
    },
    async (request) => app.services.iikoSync.syncMenu(request.id),
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
