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
