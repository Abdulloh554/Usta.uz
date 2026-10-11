# Capacity hardening — 2026-10-11

## Changes

- Production order creation now serialises submissions per account inside a MongoDB transaction. A second simultaneous submission sees the committed waiting order and gets ACTIVE_ORDER_EXISTS. Standalone production MongoDB is rejected explicitly; replica-set MongoDB is required. Six-character code collisions retry the entire transaction.
- Matching reserves masters atomically with Redis SET NX, serialises advancement per order, renews its short lease, and releases only keys still owned by that operation. Conditional database updates cannot turn a cancelled/accepted job back into a searching job. Two timeout handlers cannot both advance an already answered offer.
- Broadcasts are durable MongoDB jobs. HTTP requests enqueue and return quickly. The worker reads at most 250 recipients per batch using an ObjectId cursor. Notifications, progress, completion journal and lease release commit atomically; restart recovery resumes from the last committed batch. Admin polls a protected progress endpoint. Device push and sockets are post-commit fan-out; delivered counts mean stored in-app notifications, not guaranteed device display.
- Traffic statistics use two-stage grouping instead of unbounded distinct-ID arrays inside a facet. Groups may spill to disk, have a query deadline, share a short-lived cache and invalidate relevant caches after a new visit. Additional filter indexes are additive.
- Direct connections to a replica-set primary are correctly recognised as transaction-capable, including local integration tests.

## Validation

- 21 test suites, 293 tests passed. Added parallel create, competing master reservations, stale reservation cleanup, duplicate timeout, 503-recipient broadcast continuation/concurrency, admin-only progress and multi-source/browser/hour statistics checks.
- Backend typecheck/build and lint passed; admin production build passed.
- Real local Redis: 64 simultaneous SET NX attempts yielded one reservation; compare-and-delete rejected a stale owner.
- Isolated local read smoke: 10,000 synthetic master profiles, 200 requests, concurrency 10; 200 HTTP 200 responses, zero transport errors, p95 229 ms, p99 315 ms, 83.95 requests/sec. Test mode, local CPU/database, two public read endpoints, no connected Redis cache; this does not certify production capacity.

## Still required before a large campaign

1. Upgrade the sleeping one-instance Render free API to always-on paid compute. Size/replica count must follow measured peak traffic rather than total registered accounts. No billing changes were made.
2. Use persistent production Redis/Key Value. Matching/refresh sessions/BullMQ still depend on Redis state. Broadcast progress and in-app notifications survive in MongoDB, but this does not make all Redis data durable. Device pushes after a crash between commit and enqueue are not guaranteed.
3. Confirm the real MongoDB tier, disk capacity, connection limits, backups and restore procedure. Rotate the database password exposed by a diagnostic command error, and update Render/local credentials; Atlas account control is required for this.
4. Run an isolated production-like staging test with one million synthetic accounts plus realistic orders/messages/visits. Include login/signup, writes, acceptance races, WebSocket connections/reconnect storms, queue backlog, long-running/spike tests and infrastructure failure/recovery. The local read smoke is only a preliminary check.
5. Large admin searches still use contains regex and deep pages use skip/count; matching still joins candidate accounts before applying its final limit. Benchmark these with representative data and use cursor pagination/search indexes where measurements require it. API and background workers still share compute; separate worker hosting requires a paid service.

Never run the supplied load scripts against the live marketplace. `scripts/load-local.cjs` creates and destroys an isolated temporary replica set; `scripts/load-read.cjs` rejects the known production hosts. `scripts/add-capacity-indexes.cjs` only adds the new indexes and checks the database name; it never drops indexes or deletes rows.
