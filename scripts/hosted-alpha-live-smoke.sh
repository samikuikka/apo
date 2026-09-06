#!/usr/bin/env bash
# Read-only hosted-alpha preflight.
#
# Checks the two public origins an invited adopter depends on before the
# operator starts a rehearsal: application readiness, the browser admission
# shells, the CLI API boundary, and the canonical hosted documentation.
# No credentials, no mutations, safe to repeat.
#
# Fails by name on:
#   - an outer ingress Basic Auth gate intercepting an application route;
#   - stale hosted docs (missing /hosted-alpha/ or /start.md);
#   - a public route redirecting to localhost or an internal container
#     hostname (a misconfigured APO_PUBLIC_URL leaking topology).
#
# Usage: scripts/hosted-alpha-live-smoke.sh <app-origin> <docs-origin>
#   scripts/hosted-alpha-live-smoke.sh https://test-apo.online \
#                                       https://docs.test-apo.online
# (http:// origins are accepted only for loopback hosts — fixture testing.)
#
# HOSTED_ALPHA_EXAMPLE_URL overrides the maintained-example link probe
# (fixture testing); production always probes the published GitHub path.

set -euo pipefail

APP_URL="${1:-}"
DOCS_URL="${2:-}"
EXAMPLE_URL="${HOSTED_ALPHA_EXAMPLE_URL:-https://github.com/samikuikka/apo/tree/main/apps/example-service/e2e/agent-task-demo}"

if [[ -z "$APP_URL" || -z "$DOCS_URL" ]]; then
  echo "usage: $0 https://apo.example.com https://docs.example.com" >&2
  exit 2
fi

valid_origin() {
  local url="$1"
  [[ "$url" =~ ^https://[^/]+$ ]] && return 0
  [[ "$url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]] && return 0
  return 1
}

for origin in "$APP_URL" "$DOCS_URL"; do
  if ! valid_origin "$origin"; then
    echo "error: expected exactly one origin without a path (e.g. https://apo.example.com): $origin" >&2
    exit 2
  fi
done

TIMEOUT=15
PASS=0; FAIL=0

# fetch ORIGIN METHOD PATH — sets STATUS and HEADERS globals, does NOT
# follow redirects (internal-redirect detection inspects Location first).
fetch() {
  local origin="$1" method="$2" path="$3"
  local raw
  raw="$(curl -sS --max-time "$TIMEOUT" -D /dev/stdout -o /dev/null \
    -w $'\n__STATUS__%{http_code}' -X "$method" "$origin$path" 2>/dev/null || true)"
  STATUS="${raw##*__STATUS__}"
  HEADERS="${raw%%$'\n'__STATUS__*}"
}

assert_no_basic_challenge() {
  local description="$1"
  if echo "$HEADERS" | grep -qi '^www-authenticate: *basic'; then
    echo "FAIL: $description — outer ingress Basic Auth gate (WWW-Authenticate: Basic) intercepted the route" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

# host_of URL — scheme-stripped, port-stripped host for comparison.
host_of() {
  printf '%s' "$1" | sed -e 's#^[Hh][Tt][Tt][Pp][Ss]\?://##' -e 's#[:/?].*##'
}

# A public route that redirects into the deployment interior (localhost or a
# compose hostname) would strand an external adopter and leak topology. The
# origin's own host is exempt — loopback fixtures legitimately self-reference.
assert_no_internal_redirect() {
  local description="$1" origin="$2" path="$3"
  local origin_host; origin_host="$(host_of "$origin")"
  local location_host
  location_host="$(host_of "$(echo "$HEADERS" | grep -i '^location:' | head -1 | cut -d' ' -f2 | tr -d '\r')")"
  if [[ -n "$location_host" && "$location_host" != "$origin_host" ]] &&
    [[ "$location_host" =~ ^(localhost|127\.0\.0\.1|backend|frontend)$ ]]; then
    echo "FAIL: $description — public route redirects to an internal host" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  local effective_host
  effective_host="$(host_of "$(curl -sS -o /dev/null --max-time "$TIMEOUT" -L \
    -w '%{url_effective}' "$origin$path" 2>/dev/null || true)")"
  if [[ -n "$effective_host" && "$effective_host" != "$origin_host" ]] &&
    [[ "$effective_host" =~ ^(localhost|127\.0\.0\.1|backend|frontend)$ ]]; then
    echo "FAIL: $description — public route redirects to an internal host" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

expect_status() {
  local description="$1" expect="$2"
  if [[ "$STATUS" == "$expect" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect, got $STATUS" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

expect_status_in() {
  local description="$1"; shift
  local matched=1
  for code in "$@"; do
    [[ "$STATUS" == "$code" ]] && matched=0
  done
  if [[ "$matched" == 0 ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected one of $*, got $STATUS" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

echo "preflight $APP_URL + $DOCS_URL ..."

# --- Readiness: detail-free public health ---
health_body="$(curl -sS --max-time "$TIMEOUT" "$APP_URL/api/public/health" 2>/dev/null || echo "")"
health_status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$APP_URL/api/public/health" 2>/dev/null || echo "000")"
if [[ "$health_status" == "200" ]] && echo "$health_body" | grep -q '"status":"ready"'; then
  PASS=$((PASS + 1))
else
  echo "FAIL: readiness — expected 200 {\"status\":\"ready\"}, got $health_status" >&2
  FAIL=$((FAIL + 1))
fi

# --- Browser admission shells: application pages, no Basic prompt ---
fetch "$APP_URL" GET /login
assert_no_internal_redirect "login (application entry)" "$APP_URL" /login
if expect_status "login (application entry)" 200; then
  assert_no_basic_challenge "login (application entry)"
fi

fetch "$APP_URL" GET /join
assert_no_internal_redirect "join (invitation entry)" "$APP_URL" /join
if expect_status "join (invitation entry)" 200; then
  assert_no_basic_challenge "join (invitation entry)"
fi

# --- Public auth route: backend reached through the app origin ---
fetch "$APP_URL" GET /auth/has-users
if expect_status "has-users (CLI API entry)" 200; then
  assert_no_basic_challenge "has-users (CLI API entry)"
fi

# --- Anonymous project list: the demo contract, never a data leak ---
# Every install ships the demo workspace as a versioned fixture; the anonymous project
# list answers 200 listing exactly it. Any other project id is a cross-tenant
# leak; a Basic challenge would mean an ingress gate intercepts the route.
fetch "$APP_URL" GET /v1/projects
if expect_status "anonymous project list (demo contract)" 200; then
  if assert_no_basic_challenge "anonymous project list"; then
    projects_body="$(curl -sS --max-time "$TIMEOUT" "$APP_URL/v1/projects" 2>/dev/null || echo "")"
    if echo "$projects_body" | python3 -c "
import sys, json
try:
    projects = json.load(sys.stdin)
except Exception:
    sys.exit(1)
if not isinstance(projects, list):
    sys.exit(1)
ids = {p.get('id') for p in projects if isinstance(p, dict)}
sys.exit(0 if ids <= {'demo'} else 1)
" 2>/dev/null; then
      PASS=$((PASS + 1))
    else
      echo "FAIL: anonymous /v1/projects exposes more than the demo workspace — data leak" >&2
      FAIL=$((FAIL + 1))
    fi
  fi
fi

# --- Direct routing: Caddy must dial the backend for /backend-proxy/* ---
# When the frontend hop proxies this prefix, responses carry the Next.js
# fingerprint (pragma: no-cache with appended cache-control) — the stall
# class behind the post-#174 routing change. Absent pragma on a 200 means
# Caddy forwarded straight to uvicorn.
fetch "$APP_URL" GET /backend-proxy/v1/projects
if expect_status "backend-proxy direct routing (post-#174)" 200; then
  if echo "$HEADERS" | grep -qi '^pragma: *no-cache'; then
    echo "FAIL: /backend-proxy/v1/projects carries the Next-hop fingerprint (pragma: no-cache) — Caddy is routing through the frontend, not the backend" >&2
    FAIL=$((FAIL + 1))
  else
    PASS=$((PASS + 1))
  fi
fi

# --- SSE promptness (warning only): headers must arrive, body may stay ---
# silent — the demo has no pending batches. A header-less 2 s window is the
# measured stall symptom of SSE behind the frontend rewrite.
sse_headers="$(curl -sS -N --max-time 2 -D - -o /dev/null \
  "$APP_URL/backend-proxy/v1/events?project=demo" 2>/dev/null || true)"
if echo "$sse_headers" | grep -qi '^content-type: *text/event-stream'; then
  PASS=$((PASS + 1))
else
  echo "WARN: SSE headers not observed within 2 s on /backend-proxy/v1/events?project=demo (stall symptom — inspect routing)" >&2
fi

# --- Hosted docs: /start.md and /hosted-alpha/ must be live (not stale) ---
fetch "$DOCS_URL" GET /start.md
assert_no_internal_redirect "docs /start.md" "$DOCS_URL" /start.md
expect_status "docs /start.md" 200

fetch "$DOCS_URL" GET /hosted-alpha/
assert_no_internal_redirect "hosted-alpha documentation" "$DOCS_URL" /hosted-alpha/
expect_status "hosted-alpha documentation" 200

# --- Maintained example link resolves (the invitee's fallback path) ---
fetch "$EXAMPLE_URL" GET ""
if expect_status "maintained example link" 200; then
  :
fi

# --- Result ---
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "hosted alpha preflight: FAIL ($PASS passed, $FAIL failed)"
  exit 1
fi
echo "hosted alpha preflight: ok"
echo "  application entry: reachable"
echo "  invitation entry:  reachable"
echo "  CLI API entry:     reachable"
echo "  docs:              reachable"
echo "  readiness:         ready"
