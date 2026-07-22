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

## 3. Prove the public route

Run the smoke probe from a different machine or from the sandbox that needs to send traces:

```bash
scripts/public-ingress-smoke.sh https://apo.example.com
```

Expected output:

```text
public ingress: ok
  dashboard: https://apo.example.com/
  API:       https://apo.example.com/backend-proxy
  OTLP:      https://apo.example.com/api/public/otel/v1/traces
```

The unauthenticated OTLP probe expects `401`. That proves the public route reaches Apo while authentication remains enforced.

## 4. Connect users and agents

Use the same origin for every client, with the appropriate path:

| Client | Configuration |
|---|---|
| Dashboard | `https://apo.example.com` |
| Apo CLI | `APO_BACKEND_URL=https://apo.example.com/backend-proxy` |
| OTEL exporter | `APO_OTLP_ENDPOINT=https://apo.example.com/api/public/otel/v1/traces` |

The CLI and OTEL exporter still require their normal API credentials. Publishing Apo does not enable anonymous access.

## If HTTPS does not start

| Symptom | Check |
|---|---|
| Caddy cannot obtain a certificate | DNS resolves to this host and TCP 80/443 are reachable from the internet. |
| Dashboard loads but login redirects to localhost | `.env` contains the final `APO_PUBLIC_URL`, then the frontend was recreated. |
| CLI returns a frontend 404 | Include `/backend-proxy` in `APO_BACKEND_URL`. |
| OTEL cannot connect from a sandbox | Use the public `/api/public/otel/v1/traces` URL, not `localhost:8000`. |

For database selection, scheduler ownership, and retention settings, continue to [Configuration](/self-hosting/configuration/).
