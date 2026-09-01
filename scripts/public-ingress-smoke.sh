#!/usr/bin/env bash
# Anonymous public-ingress smoke probe.
#
# Probes the real browser and CLI entry paths from any external machine:
# the admission shells (/login, /join), the public auth route, the CLI
# bootstrap route, and the protected-data boundary. Credential-free, safe to
# repeat, no state changes.
#
# An infrastructure 401 carrying a Basic challenge is a FAILED entrypoint
# (an outer ingress gate is intercepting Apo's own authentication). An Apo
# 401 on protected data is a SUCCESSFUL authorization boundary.
#
# Usage: scripts/public-ingress-smoke.sh https://apo.example.com
# (http:// origins are accepted only for loopback hosts — fixture testing.)

set -euo pipefail

PUBLIC_URL="${1:-}"
if [[ -z "$PUBLIC_URL" ]]; then
  echo "usage: $0 https://apo.example.com" >&2
  exit 2
fi
# Accept exactly one origin (no path, query, credentials, or fragment).
# HTTPS is required for public hosts; plain HTTP is allowed only for
# loopback so the fixture-backed contract test can drive this script.
if [[ "$PUBLIC_URL" =~ ^https://[^/]+$ ]]; then
  :
elif [[ "$PUBLIC_URL" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  :
else
  echo "error: expected exactly one HTTPS origin (e.g. https://apo.example.com)" >&2
  exit 2
fi

TIMEOUT=15
PASS=0; FAIL=0

# fetch_status_and_headers METHOD PATH [DATA]
# Sets STATUS (http code) and HEADERS (response headers) globals.
fetch() {
  local method="$1" path="$2" data="${3:-}"
  local args=(
    -sS --max-time "$TIMEOUT" -D /dev/stdout -o /dev/null -w $'\n__STATUS__%{http_code}'
    -X "$method" "$PUBLIC_URL$path"
  )
  if [[ -n "$data" ]]; then
    args+=(-H "Content-Type: application/json" -d "$data")
  fi
  local raw
  raw="$(curl "${args[@]}" 2>/dev/null || true)"
  STATUS="${raw##*__STATUS__}"
  HEADERS="${raw%%$'\n'__STATUS__*}"
}

# An outer ingress Basic Auth gate is a failed entrypoint even when the
# numeric status is otherwise acceptable.
assert_no_basic_challenge() {
  local description="$1"
  if echo "$HEADERS" | grep -qi '^www-authenticate: *basic'; then
    echo "FAIL: $description — outer ingress Basic Auth gate (WWW-Authenticate: Basic) intercepted the route" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

expect_status() {
  local description="$1" expect="$2"
  local status="$3"
  if [[ "$status" == "$expect" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect, got $status" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

# expect_status_in DESCRIPTION ALLOWED...  — STATUS must be one of the listed codes.
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

echo "probing $PUBLIC_URL ..."

# --- Browser admission: /login renders Apo's UI, no native Basic prompt ---
fetch GET /login
if expect_status "login reachable" 200 "$STATUS"; then
  assert_no_basic_challenge "login"
fi

# --- Invitation admission: /join renders the join UI (invalid/missing token
#     is handled by the join page itself, still an application response) ---
fetch GET /join
if expect_status "join reachable" 200 "$STATUS"; then
  assert_no_basic_challenge "join"
fi

# --- Public auth route: bounded installation status JSON ---
fetch GET /auth/has-users
if expect_status "has-users reachable" 200 "$STATUS"; then
  assert_no_basic_challenge "has-users"
fi

# --- CLI bootstrap route: Apo's own credential validation answers
#     (401 invalid credentials / 429 rate-limited), never an ingress gate ---
fetch POST /v1/api-keys/bootstrap '{"email":"smoke-anonymous@invalid.test","password":"wrong"}'
if expect_status_in "CLI bootstrap route reachable" 401 422 429; then
  assert_no_basic_challenge "CLI bootstrap route"
fi

# --- Protected Project data: Apo 401/403 JSON, no Basic challenge ---
fetch GET /v1/projects
if expect_status_in "protected data requires Apo auth" 401 403; then
  assert_no_basic_challenge "protected data"
fi

# --- OTLP requires Apo auth (generic 401, no Basic challenge) ---
fetch POST /api/public/otel/v1/traces '{}'
if expect_status "unauthenticated OTLP returns 401" 401 "$STATUS"; then
  assert_no_basic_challenge "OTLP"
fi

# --- Public readiness (detail-free) ---
readiness_body="$(curl -sS --max-time "$TIMEOUT" "$PUBLIC_URL/api/public/health" 2>/dev/null || echo "")"
readiness_status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/public/health" 2>/dev/null || echo "000")"
if [[ "$readiness_status" == "200" ]]; then
  if echo "$readiness_body" | grep -q '"status":"ready"'; then
    # Verify no extra fields disclosed.
    if echo "$readiness_body" | python3 -c "
import sys, json
d = json.load(sys.stdin)
keys = set(d.keys())
exit(0 if keys == {'status'} else 1)
" 2>/dev/null; then
      PASS=$((PASS + 1))
    else
      echo "FAIL: readiness body has extra fields" >&2
      FAIL=$((FAIL + 1))
    fi
  else
    echo "FAIL: readiness body is not {\"status\":\"ready\"}" >&2
    FAIL=$((FAIL + 1))
  fi
else
  echo "FAIL: public readiness expected 200, got $readiness_status" >&2
  FAIL=$((FAIL + 1))
fi

# --- Private diagnostics denied (Caddy terminal 404; app auth may answer
#     307/401 first for backend-owned removed routes) ---
probe_denied() {
  local method="$1" path="$2" description="$3"
  fetch "$method" "$path"
  if [[ "$STATUS" == "404" ]] || [[ "$STATUS" == "307" ]] || [[ "$STATUS" == "401" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected 404/307/401, got $STATUS" >&2
    FAIL=$((FAIL + 1))
  fi
}
probe_denied GET "/backend-proxy/health/ready" "detailed readiness denied"
probe_denied GET "/api/health/ready" "raw health/ready denied"
probe_denied GET "/backend-proxy/docs" "Swagger docs denied"
probe_denied GET "/backend-proxy/openapi.json" "OpenAPI spec denied"
probe_denied GET "/backend-proxy/hello" "dev hello route denied"

# --- Legacy anonymous sharing removed ---
probe_denied GET "/public/traces/legacy-canary" "anonymous trace route removed"
probe_denied PATCH "/v1/runs/legacy-canary/visibility" "visibility toggle removed"

# --- Anonymous demo surface: readable, read-only, bounded ---
fetch GET "/v1/projects/demo"
if [[ "$STATUS" == "200" ]]; then
  PASS=$((PASS + 1))
else
  echo "FAIL: anonymous demo project read — expected 200, got $STATUS" >&2
  FAIL=$((FAIL + 1))
fi
if echo "$HEADERS" | grep -qi '^cache-control:.*no-store'; then
  PASS=$((PASS + 1))
else
  echo "FAIL: anonymous demo responses must carry no-store" >&2
  FAIL=$((FAIL + 1))
fi
fetch POST "/v1/agent-task-batch-runs" '{"project":"demo","selection_type":"all"}'
if [[ "$STATUS" == "401" ]]; then
  PASS=$((PASS + 1))
else
  echo "FAIL: anonymous demo mutation — expected 401, got $STATUS" >&2
  FAIL=$((FAIL + 1))
fi

# --- Security headers on dashboard ---
dash_headers="$(curl -sS --max-time "$TIMEOUT" -D - -o /dev/null "$PUBLIC_URL/" 2>/dev/null || echo "")"
if echo "$dash_headers" | grep -qi "strict-transport-security"; then
  PASS=$((PASS + 1))
else
  echo "WARN: Strict-Transport-Security header not found (may be Cloudflare-managed)" >&2
fi

# --- Result ---
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "public ingress: FAIL ($PASS passed, $FAIL failed)"
  exit 1
fi
echo "public ingress: ok ($PASS probes passed)"
echo "  login:      application reachable"
echo "  join:       application reachable"
echo "  CLI auth:   application route reachable"
echo "  protected:  Apo authentication enforced"
echo "  readiness:  ready"
