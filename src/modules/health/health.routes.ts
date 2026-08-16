import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';

interface HealthResponse {
  status: 'ok' | 'degraded';
  app: string;
  version: string;
  timezone: string;
  uptimeSeconds: number;
  checks: { api: 'ok'; database: 'ok' | 'unavailable' };
  timestamp: string;
}

const healthSchema = {
  tags: ['Health'],
  summary: 'Статус API и PostgreSQL',
  response: {
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        app: { type: 'string' },
        version: { type: 'string' },
        timezone: { type: 'string' },
        uptimeSeconds: { type: 'number' },
        checks: {
          type: 'object',
          properties: {
            api: { type: 'string' },
            database: { type: 'string' },
          },
        },
        timestamp: { type: 'string' },
      },
    },
  },
} as const;

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const buildHealth = async (): Promise<HealthResponse> => {
    let database: 'ok' | 'unavailable' = 'ok';
    try {
      await app.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unavailable';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      app: app.env.APP_NAME,
      version: '0.1.0',
      timezone: app.env.APP_TIMEZONE,
      uptimeSeconds: Math.round(process.uptime()),
      checks: { api: 'ok', database },
      timestamp: new Date().toISOString(),
    };
  };

  app.get('/health', { schema: healthSchema }, async (_request, reply) => {
    const health = await buildHealth();
    return reply.code(health.status === 'ok' ? 200 : 503).send(health);
  });

  app.get(
    `${API_PREFIX}/public/health`,
    { schema: { ...healthSchema, tags: ['Public'] } },
    async (_request, reply) => {
      const health = await buildHealth();
      return reply.code(health.status === 'ok' ? 200 : 503).send(health);
    },
  );
}
