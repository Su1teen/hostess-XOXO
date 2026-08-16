import type { AuditAction, Prisma, PrismaClient, SyncStatus } from '@prisma/client';
import { redactDeep, sanitizeMessage } from '../lib/redaction.js';
import type { IikoAttemptRecord } from './iiko-client.service.js';

export interface AuditEntry {
  action: AuditAction;
  actorType: 'ADMIN' | 'CRON' | 'SYSTEM' | 'PLUGIN' | 'IIKO';
  actorId?: string | null;
  organizationId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  requestId?: string | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export interface MinimalLogger {
  warn(payload: Record<string, unknown>, message?: string): void;
}

/**
 * Пишет аудит и журнал синхронизации. Все metadata проходят через redaction:
 * секреты, токены и API-ключи в БД не попадают.
 */
export class AuditService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: MinimalLogger,
  ) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          actorType: entry.actorType,
          actorId: entry.actorId ?? null,
          organizationId: entry.organizationId ?? null,
          entityType: entry.entityType ?? null,
          entityId: entry.entityId ?? null,
          requestId: entry.requestId ?? null,
          summary: sanitizeMessage(entry.summary).slice(0, 500),
          metadata: entry.metadata
            ? (redactDeep(entry.metadata) as Prisma.InputJsonValue)
            : undefined,
          ipAddress: entry.ipAddress ?? null,
        },
      });
    } catch (error) {
      this.logger.warn(
        { errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error)) },
        'не удалось записать audit log',
      );
    }
  }

  async recordIikoAttempt(
    attempt: IikoAttemptRecord & { organizationDbId?: string | null; roundId?: string | null },
  ): Promise<void> {
    const status: SyncStatus = attempt.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
    try {
      const finishedAt = new Date();
      await this.prisma.iikoSyncAttempt.create({
        data: {
          organizationId: attempt.organizationDbId ?? null,
          roundId: attempt.roundId ?? null,
          operation: attempt.operation,
          requestReference: attempt.requestReference ?? null,
          requestMetadata: attempt.requestMetadata
            ? (redactDeep(attempt.requestMetadata) as Prisma.InputJsonValue)
            : undefined,
          responseStatus: attempt.httpStatus ?? null,
          responseMetadata: attempt.responseMetadata
            ? (redactDeep(attempt.responseMetadata) as Prisma.InputJsonValue)
            : undefined,
          status,
          errorCode: attempt.errorCode ?? null,
          errorMessage: attempt.errorMessage
            ? sanitizeMessage(attempt.errorMessage).slice(0, 500)
            : null,
          startedAt: new Date(finishedAt.getTime() - attempt.durationMs),
          finishedAt,
        },
      });
    } catch (error) {
      this.logger.warn(
        { errorMessage: sanitizeMessage(error instanceof Error ? error.message : String(error)) },
        'не удалось записать iiko_sync_attempt',
      );
    }
  }
}
