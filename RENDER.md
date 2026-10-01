# Deploying to Render

The API validates its whole environment at boot (`src/config/env.ts`) and throws
instead of starting half-configured. That is why a missing variable shows up as
a failed deploy with

```
Error: Invalid environment configuration:
  - MONGO_URI: Required
  - REDIS_URL: Required
```

rather than as a broken endpoint later. Four variables have no default and must
be set; everything else falls back to a working value.

| Variable | Why it has no default |
| --- | --- |
| `MONGO_URI` | The Atlas connection string, credentials included. |
| `REDIS_URL` | SMS codes, refresh-token allow list, matching queue, socket fan-out. |
| `JWT_ACCESS_SECRET` | At least 32 characters. |
| `JWT_REFRESH_SECRET` | At least 32 characters, different from the access secret. |

## The live service

`Usta.uz` (`srv-daepchvqj5pc73adcj50`) runs on the Docker runtime in Oregon at
<https://usta-uz.onrender.com>, backed by the free Key Value instance
`ustauz-keyvalue` in the same region. `REDIS_URL` uses that instance's *internal*
connection string, which needs no credentials because the traffic never leaves
Render's private network:

```
REDIS_URL=redis://red-daf91ign74is738u11u0:6379
```

`render.yaml` describes the same topology. Applying it as a blueprint would
create a *second* set of services rather than adopt these, so treat it as the
written record of the configuration and change the running service in the
dashboard.

## Adding a Key Value instance from scratch

*New → Key Value*, free plan, **the same region as the web service** — the
internal connection string only resolves within a region — and `maxmemory-policy`
set to `noeviction`, because BullMQ keeps job state there and evicting a key
silently drops a queued match. Copy the **Internal Connection String** into
`REDIS_URL`.

## If the runtime is ever switched from Docker to Node

Render sets `NODE_ENV=production`, and TypeScript lives in `devDependencies`, so
the default install skips it and `tsc` is not found. The build command has to ask
for it explicitly:

```
Build Command:  npm ci --include=dev && npm run build
Start Command:  npm start
```

The Dockerfile does not have this problem: its build stage runs `npm ci` before
`NODE_ENV` is set to production, then prunes dev dependencies afterwards.

## MongoDB Atlas network access

The cluster currently accepts the connection, so nothing needs changing today —
but free Render services connect from a changing set of outbound addresses, so
narrowing the Atlas allow list later would start rejecting them and the deploy
would fail with `MongooseServerSelectionError`. Keep *Network Access* open to
`0.0.0.0/0` and rely on the connection-string credentials, or move to a paid
Render plan and allow its static outbound IPs instead.

## Capacity and scaling out

The application is written to run as several identical instances. Nothing that
matters is held in a process: sessions and rate-limit counters are in Redis,
socket fan-out goes through the Redis adapter, offer timeouts are BullMQ jobs,
and presence is a Redis counter. Adding an instance therefore needs no code
change — but the free plan this service runs on is a single small shared-CPU
instance that also sleeps when idle, and that is the ceiling long before the
code is. Moving off it is the first and largest change; everything below only
matters once that is done.

### Before running more than one instance

| Setting | Why |
| --- | --- |
| `SOCKET_TRANSPORTS=websocket` | A polling client makes its handshake and its subsequent polls on separate connections. With more than one replica those can land on different instances and the session breaks — this is exactly what sticky sessions exist to prevent, and restricting the transport removes the need for them. |
| Health check → `/health/ready` | `/health` reports only that the process is alive, on purpose: if it failed whenever Mongo or Redis did, one shared outage would have every instance restarted at once. `/health/ready` returns 503 while an instance is still connecting, has lost a backing service, or is draining for a deploy. |
| `MONGO_MAX_POOL` | Each instance opens its own pool, so the ceiling is this value times the number of instances. Keep the total under what the cluster allows. |

### Tuning one instance

- `CLUSTER_WORKERS` — Node uses one core per process. `1` is right for a
  one-core container; `0` starts one worker per CPU. Workers share the listening
  socket and keep all shared state outside the process, so nothing else changes.
- `BCRYPT_ROUNDS` — `bcryptjs` is pure JavaScript, so every sign-in costs the API
  process real CPU: measured on a development machine, roughly 420 ms per hash at
  12 rounds against 110 ms at 10. The default is now 10, which OWASP still
  considers sound. Existing hashes carry their own cost factor, so changing this
  never invalidates a password.
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

`GET /health` reports both backing services, so it distinguishes "the process is
up" from "the process can actually serve traffic":

```json
{ "success": true, "data": { "status": "ok", "mongo": "up", "redis": "up" } }
```

If `redis` reads anything other than `up`, the instance is unreachable — check
that it is in the same region and that the **internal** connection string was
used, not the external one.

## SMS

`SMS_PROVIDER` is set to `eskiz`, but `ESKIZ_EMAIL` and `ESKIZ_PASSWORD` are
empty, so the schema's defaults let the service boot while every verification
code fails to send — sign-in is broken until those two are filled in. Setting
`SMS_PROVIDER=console` instead logs the code rather than sending it, which is
the usable state while the Eskiz account is still being set up.
