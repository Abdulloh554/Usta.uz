# Deploying to Railway

The API runs on Railway as the `ustauz-api` service, next to a Railway **Redis**
service, in the project's `production` environment:

| | |
|---|---|
| Public URL | <https://ustauz-api-production.up.railway.app> (API under `/api/v1`) |
| Private URL | `ustauz-api.railway.internal` |
| Region | US West, 1 replica |
| Source | GitHub `Abdulloh554/Usta.uz`, branch `main`, auto-deploys on push |
| Builder | the `Dockerfile` in this repository (detected automatically) |
| Healthcheck | `/health` |

Railway's config-as-code file (`railway.json`) is deprecated and new services
cannot opt in, so the service is configured in the dashboard and this page is
the written record of that configuration.

## Variables

The API validates its whole environment at boot (`src/config/env.ts`) and exits
instead of starting half-configured, so a missing or wrong variable shows up as
a failed deploy (the healthcheck never passes) rather than as a broken endpoint
later. Read **Deploy Logs** first: the reason is printed there.

Four variables have no default and must be set:

| Variable | Value |
| --- | --- |
| `MONGO_URI` | The Atlas connection string, credentials included. `bad auth : authentication failed` in the logs means the user or password in it is wrong. `scripts/set-mongo-password.ps1` builds it. |
| `REDIS_URL` | A reference to the Redis service: `${{Redis.REDIS_URL}}`. It resolves to the private address, so the traffic never leaves Railway. |
| `JWT_ACCESS_SECRET` | At least 32 characters. |
| `JWT_REFRESH_SECRET` | At least 32 characters, different from the access secret. Rotating either one signs everybody out. |

The rest of what production uses:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `4000` (matches `EXPOSE` in the Dockerfile and the domain's target port) |
| `API_PREFIX` | `/api/v1` |
| `LOG_LEVEL` | `info` |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | `15m` / `30d` |
| `BCRYPT_ROUNDS` | `12` |
| `ORDER_ACCEPT_FEE` | `0` — the app is free |
| `SMS_PROVIDER` | `console` — Eskiz needs a registered company |
| `CORS_ORIGINS` | the web, admin and landing origins, comma-separated. Empty allows every browser origin (the server warns at start-up); the mobile app sends no `Origin` and is unaffected. |
| `MAIL_PROVIDER`, `BREVO_API_KEY`, `MAIL_FROM` | see *Email* below |
| `BFF_SHARED_SECRET` | the same value as on the web app; see `web/DEPLOY.md` |
| `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | browser push; see `web/DEPLOY.md` |
| `CLOUDINARY_*`, `FCM_*`, `SENTRY_DSN`, `GROQ_*`, `MANUAL_PAYMENT_*` | optional; each feature is off until its variables exist |

A variable change triggers a redeploy on its own; Railway shows the staged
change and deploys it when you press **Deploy**.

## Redis

Add it from **+ Add → Database → Redis**. BullMQ keeps job state there, so the
Redis must not evict keys under memory pressure: in the Redis service's
**Data** tab run `CONFIG GET maxmemory-policy`, and if it is not `noeviction`,
`CONFIG SET maxmemory-policy noeviction`. The volume Railway attaches keeps the
data across restarts.

## MongoDB Atlas network access

Railway connects from a changing set of outbound addresses, so Atlas
*Network Access* must stay open to `0.0.0.0/0` and rely on the
connection-string credentials. Narrowing it makes the deploy fail with
`MongooseServerSelectionError`.

## Capacity and scaling out

The application is written to run as several identical instances. Nothing that
matters is held in a process: sessions and rate-limit counters are in Redis,
socket fan-out goes through the Redis adapter, offer timeouts are BullMQ jobs,
and presence is a Redis counter. Adding a replica (Settings → Scale) therefore
needs no code change. Railway does not put the service to sleep unless
*Serverless* is switched on — keep it off, or the first request after an idle
spell waits for a cold start.

### Before running more than one replica

| Setting | Why |
| --- | --- |
| `SOCKET_TRANSPORTS=websocket` | A polling client makes its handshake and its subsequent polls on separate connections. With more than one replica those can land on different instances and the session breaks — this is exactly what sticky sessions exist to prevent, and restricting the transport removes the need for them. |
| Healthcheck → `/health/ready` | `/health` reports only that the process is alive, on purpose: if it failed whenever Mongo or Redis did, one shared outage would have every instance restarted at once. `/health/ready` returns 503 while an instance is still connecting, has lost a backing service, or is draining for a deploy. |
| `MONGO_MAX_POOL` | Each instance opens its own pool, so the ceiling is this value times the number of instances. Keep the total under what the cluster allows. |

### Tuning one instance

- `CLUSTER_WORKERS` — Node uses one core per process. `1` is right for a
  one-core container; `0` starts one worker per CPU. Workers share the listening
  socket and keep all shared state outside the process, so nothing else changes.
- `BCRYPT_ROUNDS` — `bcryptjs` is pure JavaScript, so every sign-in costs the API
  process real CPU: measured on a development machine, roughly 420 ms per hash at
  12 rounds against 110 ms at 10. Existing hashes carry their own cost factor, so
  changing this never invalidates a password.
- `STATS_CACHE_SECONDS` — the admin dashboard is thirty-odd whole-collection
  counts behind one screen, and it competes with the request path for the same
  connections. It is cached for 30 seconds by default.
- `PRESENCE_SEEN_THROTTLE_SECONDS` — a phone on a mobile network reconnects
  constantly. `lastSeenAt` is written at most once per window instead of once per
  reconnect, which at scale is the single heaviest write in the system.
- `RATE_LIMIT_GLOBAL_MAX` — the budget is counted per signed-in account, falling
  back to the IP only for anonymous requests. Uzbek carriers put very large
  numbers of subscribers behind a handful of NAT addresses, so an IP-only limit
  would be shared between strangers.

### Indexes

`MONGO_AUTO_INDEX` is on by default, which is right while the database is small.
Once collections are large, turn it off so a deploy never triggers an index build
against live traffic, and apply schema index changes deliberately:

```bash
npm run indexes:sync
```

`syncIndexes` also drops indexes the schemas no longer declare, so it is the
whole reconciliation rather than only the additions.

### Shutdown

`SIGTERM` fails the readiness probe first, so the load balancer stops sending new
requests while the instance is still serving the ones it has. It then stops
accepting connections, disconnects the web sockets — which never close on their
own, and would otherwise keep the drain waiting forever — finishes the workers,
and closes Mongo and Redis. `SHUTDOWN_TIMEOUT_MS` bounds the whole sequence,
because a drain that hangs holds the deploy open until the platform sends
`SIGKILL`, and that is the one exit that drops in-flight work.

## Verifying

`GET /health` reports both backing services:

```json
{ "success": true, "data": { "status": "ok", "mongo": "up", "redis": "up" } }
```

`Application not found` from the public URL means no deployment has passed its
healthcheck yet — open the latest deployment's **Deploy Logs**.

## Email (verification codes)

The one code the app sends — the password-reset code — goes out by email.
**Railway blocks outbound SMTP below the Pro plan**, so Gmail SMTP cannot send
from there. Use Brevo's HTTPS API: create a free Brevo account, verify the
sender address, make an API key, then set `MAIL_PROVIDER=brevo`,
`BREVO_API_KEY=<key>` and `MAIL_FROM` (the verified sender). With
`MAIL_PROVIDER=console` (the default) the code is only logged. Gmail SMTP
(`MAIL_PROVIDER=smtp`, `SMTP_USER`, `SMTP_PASSWORD` as an app password) still
works locally.

SMS is switched off (`SMS_PROVIDER=console`): Eskiz only serves registered
companies. The Eskiz and Play Mobile providers stay in the code for when that
changes.
