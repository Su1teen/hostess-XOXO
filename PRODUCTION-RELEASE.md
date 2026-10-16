# Production release

Railway runs reviewed Prisma migrations in a separate pre-deploy phase using npm run db:migrate:deploy. Application startup is npm run start, without implicit DDL or catalog seeding. Prisma CLI is a runtime dependency. Do not use reset or db push on the shared production database.

See docs/QR_ORDER_INTEGRATION.md for the QR event lifecycle, safe rollout and rollback. The new feature defaults to disabled until QR_ORDER_EVENTS_ENABLED=true is set on hostess-XOXO. Existing DATABASE_URL and COMMAND_CENTER_SERVICE_KEY are reused.

Catalog seed remains an explicit initialization command and must not run on every restart. Check /health and read-only /api/v1/public/snapshot after deploy and keep the previous application SHA for rollback.
