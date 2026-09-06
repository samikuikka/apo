---
title: Publish Apo on Your Domain
description: Run the self-hosted Server Profile with automatic HTTPS for the dashboard, CLI, and OTEL.
---

The Server Profile turns one self-hosted Apo machine into a stable HTTPS endpoint that browsers, the CLI, and sandboxed agents can reach. Caddy is the included TLS front door; it does not change Apo's single-node architecture.

```text
browser / CLI / sandbox
          │ HTTPS
          ▼
 https://apo.example.com
          │
        Caddy
          │ private Compose network
          ▼
 frontend ── backend ── SQLite/Postgres
```

## Before you start

You need one Linux host with Docker Compose, a domain name, and inbound TCP ports 80 and 443. Create an `A` or `AAAA` record for the Apo hostname that points to the host before starting Caddy.

:::note
Caddy is the supported reference ingress, not an Apo dependency. If your organization already terminates TLS with nginx, Traefik, Cloudflare Tunnel, or a load balancer, forward that origin to the frontend on port 3000 instead.
:::

:::caution[Trace data during the trial]
Apo stores received Trace Content in full and keeps it indefinitely by
default. Automatic backups are not included. Configure retention deliberately,
protect the persistent data volume, and remember that deleting Apo data cannot
erase copies in VM snapshots or operator-created backups.
:::

## 1. Configure the public origin

Create `.env` from the template and generate the shared signing secret:

```bash
cp .env.example .env
sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=$(openssl rand -hex 32)/" .env
sed -i 's|^APO_DEPLOYMENT_PROFILE=.*|APO_DEPLOYMENT_PROFILE=server|' .env
sed -i 's|^APO_PUBLIC_URL=.*|APO_PUBLIC_URL=https://apo.example.com|' .env
```

Replace `apo.example.com` with the hostname people and agents will use. `APO_PUBLIC_URL` must be one HTTPS origin without a path.

## 2. Start the Server Profile

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

The resulting services are:

```text
frontend   internal application service; loopback diagnostic port 3000
backend    internal API service; loopback diagnostic port 8000
caddy      public ingress on 80/tcp, 443/tcp, and 443/udp
```

Caddy obtains and renews the certificate automatically. Its certificate state is persisted in the `caddy_data` volume.

### Upgrades: recreate caddy when the Caddyfile changed

`up -d --build` recreates a container only when its image or Compose config
changed — and a Caddyfile *content* change is neither. The Caddyfile is
bind-mounted as a single file, so a checkout update replaces it by rename
(new inode) while the running container keeps reading the old one. The
result is silent drift: every Caddyfile change you *think* you deployed is
still not live.

After any upgrade that touched `deploy/self-host/Caddyfile`, recreate caddy
explicitly (expect a seconds-long connection-reset window):

```bash
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --force-recreate caddy
```

```text
Container apo-caddy-1  Recreated
Container apo-caddy-1  Started
```

Then prove routing took the new config — a direct backend answer carries no
`pragma: no-cache` header (that fingerprint means the request still hops
through the frontend):

```bash
curl -sS -D - -o /dev/null https://apo.example.com/backend-proxy/v1/projects | grep -i pragma
# no output = direct routing is live
```

:::caution[One-time drift repair]
If caddy has not been recreated since a Caddyfile change, `caddy reload`
cannot fix it either — reload re-reads the still-mounted old inode. Only
`--force-recreate caddy` re-resolves the bind mount.
:::

## 3. Prove the public route

Run the smoke probe from a different machine or from the sandbox that needs to send traces:

```bash
scripts/public-ingress-smoke.sh https://apo.example.com
```

Expected output:

```text
public ingress: ok
  login:      application reachable
  join:       application reachable
  CLI auth:   application route reachable
  protected:  Apo authentication enforced
  readiness:  ready
```

The probe checks the real entry paths, not just transport: the admission shells (`/login`, `/join`) must render Apo's own UI, the CLI routes must answer with Apo's validation responses, and protected data must return an Apo `401`, never an outer `WWW-Authenticate: Basic` challenge. An infrastructure `401` with a Basic challenge is a failed entrypoint; an Apo `401` on protected data is a successful authorization boundary.

## 4. Connect users and agents

Use the same origin for every client, with the appropriate path:

| Client | Configuration |
|---|---|
| Dashboard | `https://apo.example.com` |
| Apo CLI | `APO_BACKEND_URL=https://apo.example.com` |
| OTEL exporter | `APO_OTLP_ENDPOINT=https://apo.example.com/api/public/otel/v1/traces` |

The CLI and OTEL exporter still require their normal API credentials. Publishing Apo does not enable anonymous access to your data, admission to a hosted installation is invitation-only, and every protected route requires an Apo session, API key, or task token.

One deliberate exception: the read-only **demo workspace** is browsable without an account, so visitors can see Apo in action before committing to anything. Anonymous visitors can only ever read the demo project (at the viewer role); every mutation and every other project behaves exactly like an unauthenticated request. The demo's data is a frozen, fixture-shipped snapshot, nothing a visitor does can change it, and nothing of yours is exposed.

| Variable | Default | Effect |
|---|---|---|
| `APO_DEMO_ENABLED` | `true` | Set `false` to remove the demo workspace (and anonymous access) from this installation entirely. |
| `DEMO_ANON_RATE_LIMIT_MAX` | `120` | Anonymous requests per IP per window. |
| `DEMO_ANON_RATE_LIMIT_WINDOW_SECONDS` | `60` | The rate-limit window in seconds. |

:::note[One origin, one authentication boundary]
The ingress (Caddy) owns TLS and routing only. It never asks for a password of its own: browsers get Apo's login and invitation pages directly, and `apo login --backend https://apo.example.com` works without any ingress credential. Apo's application authentication (sessions, API keys, and Project authorization) is the only security boundary in front of your data.
:::

## If HTTPS does not start

| Symptom | Check |
|---|---|
| Caddy cannot obtain a certificate | DNS resolves to this host and TCP 80/443 are reachable from the internet. |
| Dashboard loads but login redirects to localhost | `.env` contains the final `APO_PUBLIC_URL`, then the frontend was recreated. |
| CLI cannot connect from a sandbox | Use the public origin `https://apo.example.com` directly, not `localhost:8000`. The `/v1/*` and `/auth/*` routes the CLI calls are served on the same origin. |
| OTEL cannot connect from a sandbox | Use the public `/api/public/otel/v1/traces` URL, not `localhost:8000`. |

For database selection, scheduler ownership, and retention settings, continue to [Configuration](/self-hosting/configuration/).
