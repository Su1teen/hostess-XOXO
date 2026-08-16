import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createServices, type ContainerLogger } from '../services/container.js';

/** Подключает Prisma и сервисный слой; корректно закрывает соединение при остановке. */
export const prismaPlugin = fp(async (app: FastifyInstance) => {
  const prisma = new PrismaClient({
    log: app.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  await prisma.$connect();

  app.decorate('prisma', prisma);
  app.decorate('services', createServices(prisma, app.env, app.log as unknown as ContainerLogger));

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });
});
