import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiningReadService } from '../src/modules/bartender/dining-read.service.js';
import { bartenderRoutes } from '../src/modules/bartender/bartender.routes.js';
import { BartenderSessionService } from '../src/modules/bartender/bartender.session.js';
import { parseEnv } from '../src/config/env.js';

describe('authenticated Command Center read view', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('does not call Command Center without a bartender session and never queries XOXO database', async () => {
    const query = vi.fn(async () => []),
      execute = vi.fn();
    const app = fastify();
    app.decorate('prisma', {
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ $executeRaw: execute, $queryRaw: query }),
    } as never);
    const remote = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source: 'command_center',
            currency: 'KZT',
            generatedAt: new Date().toISOString(),
            scope: 'active',
            orders: [],
            hasMore: false,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', remote);
    app.decorate(
      'env',
      parseEnv({
        DATABASE_URL: 'postgresql://localhost:1/unused',
        ADMIN_API_KEY: '0123456789abcdef',
        COMMAND_CENTER_SERVICE_KEY: 'test-service-key-at-least-32-characters',
        COMMAND_CENTER_READ_ORIGIN: 'https://command.test',
      }),
    );
    const sessions = new BartenderSessionService({
      pin: '1234',
      sessionTtlMinutes: 10,
      maxAttempts: 5,
      attemptWindowSeconds: 60,
    });
    app.decorate('services', { bartenderSessions: sessions } as never);
    await app.register(bartenderRoutes);
    expect((await app.inject({ url: '/api/v1/bartender/dining/orders' })).statusCode).toBe(401);
    expect(remote).not.toHaveBeenCalled();
    const session = sessions.login('1234');
    const response = await app.inject({
      url: '/api/v1/bartender/dining/orders',
      headers: { 'x-bartender-token': session.token },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ source: 'command_center', orders: [], hasMore: false });
    expect(remote).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          url: '/api/v1/bartender/dining/orders?scope=all',
          headers: { 'x-bartender-token': session.token },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
  });
  it('reports unavailable schema instead of inventing an empty queue', async () => {
    const service = new DiningReadService({
      $transaction: vi.fn(async () => {
        throw new Error('missing relation or connection');
      }),
    } as never);
    await expect(service.orders()).rejects.toMatchObject({
      code: 'DATABASE_UNAVAILABLE',
      statusCode: 503,
    });
  });
  it('signals truncation without presenting a partial table total as complete', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i) }));
    const service = new DiningReadService({
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({ $executeRaw: vi.fn(), $queryRaw: async () => rows }),
    } as never);
    expect(await service.orders('recent')).toMatchObject({
      scope: 'recent',
      hasMore: true,
      orders: rows.slice(0, 100),
    });
  });
});
