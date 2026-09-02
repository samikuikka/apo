#!/usr/bin/env bash
# Fixture-backed contract for the public-ingress smoke probe.
#
# 5. The smoke script must FAIL (and name the Basic Auth gate) against a
#    fixture that answers admission routes with 401 + WWW-Authenticate: Basic.
# 6. The smoke script must PASS against a fixture that answers admission
#    routes as Apo would — including an anonymous project list that carries
#    only the public demo workspace — without confusing application auth
#    with ingress auth.
# 7. The smoke script must FAIL (and name the leak) against a fixture whose
#    anonymous project list also contains a member project.
#
# Run: bash tests/deployment/public-ingress-smoke-contract.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
FIXTURE_URL="http://127.0.0.1:${PORT}"

failures=0

start_fixture() {
  local mode="$1"
  node "$REPO_ROOT/tests/deployment/public-ingress-smoke-fixture.mjs" "$PORT" "$mode" &
  FIXTURE_PID=$!
  # Wait for the readiness line so the smoke never races the listener.
  for _ in $(seq 1 50); do
    if curl -sS -o /dev/null --max-time 1 "$FIXTURE_URL/api/public/health" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "FAIL: fixture ($mode) did not become ready" >&2
  return 1
}

stop_fixture() {
  kill "$FIXTURE_PID" 2>/dev/null || true
  wait "$FIXTURE_PID" 2>/dev/null || true
}

# --- Test 6 first: the target topology must pass ---
start_fixture app
trap stop_fixture EXIT
if "$REPO_ROOT/scripts/public-ingress-smoke.sh" "$FIXTURE_URL" > /tmp/smoke-app.out 2>&1; then
  echo "smoke accepts Apo application auth: ok"
else
  echo "FAIL: smoke rejected the app-auth fixture (expected success):" >&2
  cat /tmp/smoke-app.out >&2
  failures=$((failures + 1))
fi
stop_fixture
trap - EXIT

# --- Test 7: an anonymous list that leaks a member project must fail ---
start_fixture app-leak
trap stop_fixture EXIT
if "$REPO_ROOT/scripts/public-ingress-smoke.sh" "$FIXTURE_URL" > /tmp/smoke-leak.out 2>&1; then
  echo "FAIL: smoke accepted a non-demo project in the anonymous list (expected failure):" >&2
  cat /tmp/smoke-leak.out >&2
  failures=$((failures + 1))
else
  if grep -qi "demo workspace" /tmp/smoke-leak.out; then
    echo "smoke rejects anonymous data leakage: ok"
  else
    echo "FAIL: smoke failed but did not identify the anonymous data leak:" >&2
    cat /tmp/smoke-leak.out >&2
    failures=$((failures + 1))
  fi
fi
stop_fixture
trap - EXIT

# --- Test 5: the former all-routes Basic Auth gate must fail ---
start_fixture basic-gate
trap stop_fixture EXIT
if "$REPO_ROOT/scripts/public-ingress-smoke.sh" "$FIXTURE_URL" > /tmp/smoke-basic.out 2>&1; then
  echo "FAIL: smoke accepted an outer ingress Basic Auth gate (expected failure):" >&2
  cat /tmp/smoke-basic.out >&2
  failures=$((failures + 1))
else
  if grep -qi "basic auth gate" /tmp/smoke-basic.out; then
    echo "smoke rejects an ingress Basic challenge: ok"
  else
    echo "FAIL: smoke failed but did not identify the Basic Auth gate:" >&2
    cat /tmp/smoke-basic.out >&2
    failures=$((failures + 1))
  fi
fi
stop_fixture
trap - EXIT

rm -f /tmp/smoke-app.out /tmp/smoke-leak.out /tmp/smoke-basic.out

if [[ "$failures" -gt 0 ]]; then
  echo "public ingress smoke contract: FAIL ($failures)"
  exit 1
fi
echo "public ingress smoke contract: ok"
