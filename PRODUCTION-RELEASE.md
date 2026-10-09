# Production release

Railway starts the application without implicit DDL or catalog writes. Run `npm run db:migrate:deploy` separately after reviewing pending migrations and obtaining required production approval. Existing databases already contain the exchange catalog.

`npm run db:seed` is an explicit initialization operation: it can update catalog limits and active flags and select a demo organization. Do not run it on every restart or use it to supply kitchen menu data. Back up the database before any approved initialization.

Check `/health` and read-only `/api/v1/public/snapshot` after deployment. Keep the previous deployed commit SHA available for rollback.
