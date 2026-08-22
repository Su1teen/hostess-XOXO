-- Adds lifecycle/audit values used by the idempotent round transition.
ALTER TYPE "RoundStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROUND_TRANSITION';
