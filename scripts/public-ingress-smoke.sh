#!/usr/bin/env bash
# Probe a running public Server Profile from a machine outside the Apo host.
# Usage: scripts/public-ingress-smoke.sh https://apo.example.com

set -euo pipefail

PUBLIC_URL="${1:-}"
if [[ ! "$PUBLIC_URL" =~ ^https://[^/]+/?$ ]]; then
  echo "usage: $0 https://apo.example.com" >&2
  exit 2
fi
PUBLIC_URL="${PUBLIC_URL%/}"

curl -fsS --max-time 15 -o /dev/null "$PUBLIC_URL/"
curl -fsS --max-time 15 -o /dev/null "$PUBLIC_URL/backend-proxy/health/ready"

otel_status="$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' -d '{}' \
  "$PUBLIC_URL/api/public/otel/v1/traces")"
if [[ "$otel_status" != "401" ]]; then
  echo "expected unauthenticated OTLP probe to return 401, got $otel_status" >&2
  exit 1
fi

printf 'public ingress: ok\n  dashboard: %s/\n  API:       %s/backend-proxy\n  OTLP:      %s/api/public/otel/v1/traces\n' \
  "$PUBLIC_URL" "$PUBLIC_URL" "$PUBLIC_URL"
