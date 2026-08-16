import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { pluginDisabled, unauthorized } from '../lib/errors.js';
import { safeCompare } from '../lib/idempotency.js';

/**
 * Аутентификация администратора и iikoFront plugin.
 * Ключи сравниваются timing-safe и никогда не попадают в логи.
 */
export const authPlugin = fp(async (app: FastifyInstance) => {
  const adminHeader = app.env.ADMIN_API_KEY_HEADER.toLowerCase();

  app.decorate('requireAdmin', async (request: FastifyRequest, _reply: FastifyReply) => {
    const provided = request.headers[adminHeader];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!safeCompare(value, app.env.ADMIN_API_KEY)) {
      throw unauthorized();
    }
  });

  app.decorate('requirePluginSecret', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!app.env.FRONT_PLUGIN_ENABLED) {
      throw pluginDisabled();
    }
    const provided = request.headers['x-plugin-secret'];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!safeCompare(value, app.env.FRONT_PLUGIN_SHARED_SECRET)) {
      throw unauthorized();
    }
  });
});
