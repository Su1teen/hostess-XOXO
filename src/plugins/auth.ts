import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import fp from 'fastify-plugin';
import { pluginDisabled, unauthorized } from '../lib/errors.js';
import { safeCompare } from '../lib/idempotency.js';

/**
 * Аутентификация администратора и iikoFront plugin.
 * Ключи сравниваются timing-safe и никогда не попадают в логи.
 */
export function verifyBartenderPin(pin: string, env: FastifyInstance['env']): boolean {
  if (env.BARTENDER_PIN_HASH) {
    const [algorithm, salt, expected] = env.BARTENDER_PIN_HASH.split(':');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const actual = crypto.scryptSync(pin, salt, 32).toString('hex');
    return safeCompare(actual, expected);
  }
  return Boolean(env.BARTENDER_PIN) && safeCompare(pin, env.BARTENDER_PIN);
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  const bartenderSessions = new Map<string, number>();
  const adminHeader = app.env.ADMIN_API_KEY_HEADER.toLowerCase();

  app.decorate('requireAdmin', async (request: FastifyRequest, _reply: FastifyReply) => {
    const provided = request.headers[adminHeader];
    const value = Array.isArray(provided) ? provided[0] : provided;
    if (!safeCompare(value, app.env.ADMIN_API_KEY)) {
      throw unauthorized();
    }
  });

  app.decorate('createBartenderSession', () => {
    const token = crypto.randomBytes(32).toString('hex');
    bartenderSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
    return token;
  });
  app.decorate('clearBartenderSession', (token: string) => bartenderSessions.delete(token));
  app.decorate('requireBartender', async (request: FastifyRequest, _reply: FastifyReply) => {
    const provided = request.headers['x-bartender-token'];
    const token = Array.isArray(provided) ? provided[0] : provided;
    const expiry = token ? bartenderSessions.get(token) : undefined;
    if (!expiry || expiry <= Date.now()) {
      if (token) bartenderSessions.delete(token);
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
