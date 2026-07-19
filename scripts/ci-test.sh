#!/usr/bin/env bash
#
# Run an agent task with CI context from the current git repo.
#
# Usage:
#   ./scripts/ci-test.sh                     # run meeting-summary
#   ./scripts/ci-test.sh document-qa         # run specific task
#   ./scripts/ci-test.sh meeting-summary 42  # simulate PR #42
#
# Works against your local backend by default.
# Point to a remote backend: APO_BACKEND_URL=https://... ./scripts/ci-test.sh

set -euo pipefail

TASK_ID="${1:-meeting-summary}"
PR="${2:-}"
BACKEND_URL="${APO_BACKEND_URL:-http://localhost:8000}"
PROJECT="${APO_PROJECT_ID:-example-service}"
TASK_ROOT="${APO_TASK_ROOT:-./apps/example-service/e2e}"

REPO="$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' || echo 'local/repo')"
SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
BRANCH="$(git branch --show-current 2>/dev/null || echo 'unknown')"

if ! curl -sf "$BACKEND_URL/health" > /dev/null 2>&1; then
  echo "Backend not reachable at $BACKEND_URL"
  echo "Falling back to local run (no persistence, no traces)"
  echo ""
  node --experimental-strip-types packages/cli/src/main.ts task run "$TASK_ID" --dir "$TASK_ROOT"
  exit $?
fi

exec node --experimental-strip-types packages/cli/src/main.ts task run "$TASK_ID" \
  --ci \
  --project "$PROJECT" \
  --dir "$TASK_ROOT" \
  --backend "$BACKEND_URL" \
  --repo "$REPO" \
  --sha "$SHA" \
  ${PR:+--pr "$PR"} \
  --branch "$BRANCH"
