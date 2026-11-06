#!/usr/bin/env bash
# Contract tests for the public docs deployment overlay.
#
# Renders the full tunnel + public-docs Compose stack and asserts the docs
# service, Caddy host routing, and Cloudflare Tunnel ingress match the
# Public HTTP contract — without needing live DNS or the VPS.
#
# Run: bash tests/deployment/public-docs-contract.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDERED_CONFIG="$(mktemp)"
RENDERED_UMAMI_CONFIG="$(mktemp)"
RENDERED_SERVER_CONFIG="$(mktemp)"
trap 'rm -f "$RENDERED_CONFIG" "$RENDERED_UMAMI_CONFIG" "$RENDERED_SERVER_CONFIG"' EXIT

export AUTH_SECRET="public-docs-contract-secret"
export APO_PUBLIC_URL="https://test-apo.online"
export APO_CLOUDFLARE_TUNNEL_TOKEN="public-docs-contract-token"
export APO_DOCS_HOST="docs.test-apo.online"

# Base render: tunnel + public docs, without the umami overlay. The umami host
# must fall back to the reserved never-resolving TLD so the stack stays valid
# for deployments that opt out of analytics.
docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.override.yml" \
  -f "$REPO_ROOT/docker-compose.public-docs.yml" \
  config --format json > "$RENDERED_CONFIG"

# Umami render: the operator stack as apo-mode tunnel assembles it.
export APO_UMAMI_HOST="umami.test-apo.online"
export APO_UMAMI_APP_SECRET="umami-contract-app-secret"
export APO_UMAMI_DB_PASSWORD="umami-contract-db-password"
export PUBLIC_UMAMI_URL="https://umami.test-apo.online"
export PUBLIC_UMAMI_WEBSITE_ID="11111111-2222-3333-4444-555555555555"

docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.override.yml" \
  -f "$REPO_ROOT/docker-compose.public-docs.yml" \
  -f "$REPO_ROOT/docker-compose.umami.yml" \
  config --format json > "$RENDERED_UMAMI_CONFIG"

# Direct-mode render (server profile, no docs/umami overlays): the disabled
# host defaults must not compose bare reserved-TLD hostnames, which would
# mean automatic HTTPS and endless ACME retries for a TLD no CA can reach.
# APO_DOCS_HOST must stay unset for this render, so run it in a clean env.
env -i PATH="$PATH" HOME="$HOME" \
  AUTH_SECRET="public-docs-contract-secret" \
  APO_PUBLIC_URL="https://test-apo.online" \
  docker compose \
    -f "$REPO_ROOT/docker-compose.yml" \
    -f "$REPO_ROOT/docker-compose.server.yml" \
    config --format json > "$RENDERED_SERVER_CONFIG"

cd "$REPO_ROOT"
node tests/deployment/public-docs-contract.mjs "$RENDERED_CONFIG" "$RENDERED_UMAMI_CONFIG" "$RENDERED_SERVER_CONFIG"
