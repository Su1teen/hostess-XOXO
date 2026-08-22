import type { PrismaClient } from '@prisma/client';
import type { AppEnv } from '../config/env.js';
import type { AppServices } from '../services/container.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
    env: AppEnv;
    services: AppServices;
    requireAdmin: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    requirePluginSecret: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    requireBartender: (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => Promise<void>;
    createBartenderSession: () => string;
    clearBartenderSession: (token: string) => boolean;
  }
}

export {};
