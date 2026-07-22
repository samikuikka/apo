#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RENDERED_CONFIG="$(mktemp)"
trap 'rm -f "$RENDERED_CONFIG"' EXIT

export AUTH_SECRET="public-ingress-contract-secret"
export APO_PUBLIC_URL="https://apo.example.com"

docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.server.yml" \
  config --format json > "$RENDERED_CONFIG"

cd "$REPO_ROOT"
node scripts/test-public-ingress-contract.mjs "$RENDERED_CONFIG"
