# Local/GitHub reconciliation — 2026-10-17

The local repositories contained unfinished work alongside newer upstream main commits. Initial repositories (including Git state and untracked files, excluding installed dependencies/build caches) were backed up in the reconciliation workspace before editing. Published history was preserved; no force push or rebase was used. All existing remote feature branches were already ancestors of upstream main; there were no open pull requests.

Resolved the unfinished merge of local 7fc91b0 with upstream 49b7b08. Upstream preview source snapshots and atomic manual-source closure supersede the older local preview workaround. Kept local read-only public pricing, published reference amounts, rollback locking/revalidation and isolated-database guards. Updated the installed Prisma client from the current schema.

Validation: all 224 tests passed, including 25 PostgreSQL receiver tests and 8 exchange pipeline tests; typecheck/lint/build passed. A real HTTP cross-service test with the current Command Center checkout/outbox passed: accepted and cancelled events delivered, duplicate delivery deduplicated, net QR units zero, original 1590 KZT price unchanged. Only disposable local test databases were used.

This reconciliation does not establish production guest checkout readiness. Earlier production evidence in the repositories reports a Hostess Cloudflare BFF configuration blocker and disabled Command Center outbox; production credentials, flags, customer orders and QR tokens were not changed by this reconciliation.
