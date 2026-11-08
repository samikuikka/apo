#!/usr/bin/env python3
"""OTLP projection-loss load test.

Spins up a throwaway backend (fresh SQLite file, demo fixture off, admission
limits raised so 429s stay out of the measurement), drives concurrent OTLP
ingest through the real HTTP surface, waits for the ingestion queue to drain,
then compares three counts for the load-test project:

  accepted   spans the receiver reported accepted (X-Otlp-Accepted totals)
  canonical  rows in otlp_spans (the lossless source of truth)
  projected  rows in logged_calls (the product-facing projection)

Projection loss = accepted - projected. Any loss is a FAIL: once the receiver
has accepted a span, the only way it may fail to project is loudly (batch
status failed/partial with an error, retried until it lands).

Usage (from the repo root):

    python3 scripts/loadtest/otlp_projection_loss.py            # 5 and 20
    python3 scripts/loadtest/otlp_projection_loss.py -c 5 -c 20
    python3 scripts/loadtest/otlp_projection_loss.py --spans 256 --traces 4
    python3 scripts/loadtest/otlp_projection_loss.py --keep     # keep stack + logs

Defaults mirror real exporter traffic: the collector sidecar sends
hundreds of spans per OTLP request, so each POST is one large batch.

Each concurrency level gets its own fresh database and server instance.
"""

from __future__ import annotations

import argparse
import json
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
BACKEND = REPO / "backend"
PROJECT_ID = "loadtest"
EMAIL = "load@test.local"
DRAIN_TIMEOUT_S = 240

# Set from argv in main(); defaults mirror the collector sidecar's real
# batch shape (hundreds of spans per OTLP request).
TRACES_PER_WORKER = 4
SPANS_PER_TRACE = 256

# Raised admission limits so the test measures SQLite lock behavior, not the
# rate limiter. Concurrency cap comfortably above the highest level tested.
SERVER_ENV = {
    "APO_DEMO_ENABLED": "false",
    "APO_TELEMETRY_MAX_CONCURRENT_REQUESTS": "128",
    "APO_TELEMETRY_REQUESTS_PER_MINUTE": "100000",
    "APO_TELEMETRY_REQUEST_BURST": "100000",
    "APO_TELEMETRY_GLOBAL_REQUESTS_PER_MINUTE": "100000",
    "APO_TELEMETRY_GLOBAL_REQUEST_BURST": "100000",
    "APO_TELEMETRY_UNITS_PER_MINUTE": "1000000",
    "APO_TELEMETRY_UNIT_BURST": "1000000",
    "APO_TELEMETRY_GLOBAL_UNITS_PER_MINUTE": "1000000",
    "APO_TELEMETRY_GLOBAL_UNIT_BURST": "1000000",
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_healthy(port: int, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/health", timeout=2
            ) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(0.3)
    raise SystemExit(f"backend on :{port} never became healthy")


SEED_SCRIPT = """
import hashlib, secrets, sys
from sqlmodel import Session
from apo.db import engine
from apo.models.db import ApiKeyDB, ProjectDB, ProjectMembershipDB, UserDB

user = UserDB(email="load@test.local", name="Load Test", password_hash="x",
              is_admin=True)
project = ProjectDB(id="loadtest", name="loadtest", created_by=user.id)
membership = ProjectMembershipDB(project_id="loadtest", user_id=user.id,
                                 role="owner")
full_key = "sk-load" + secrets.token_hex(20)
key = ApiKeyDB(name="loadtest", hashed_key=hashlib.sha256(full_key.encode()).hexdigest(),
               prefix=full_key[:8], project="loadtest", created_by=user.id,
               scope="full")
with Session(engine) as session:
    session.add(user)
    session.flush()
    for row in (project, membership, key):
        session.add(row)
    session.commit()
print(full_key)
"""


def seed(db_path: Path) -> str:
    """Create user + project + membership + legacy API key via the ORM.

    Runs in a subprocess against the scratch DATABASE_URL so ORM defaults
    (NOT NULL columns with Python-side defaults) match exactly what the
    server itself would write.
    """
    import os

    result = subprocess.run(
        ["uv", "run", "python", "-c", SEED_SCRIPT],
        cwd=BACKEND,
        env={**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"},
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"seed failed:\n{result.stderr[-2000:]}")
    return result.stdout.strip().splitlines()[-1]


def make_trace(worker: int, seq: int) -> list[dict[str, object]]:
    """One trace: root AGENT span + GENERATION/TOOL children, gen_ai attrs."""
    tag = f"{worker:02x}{seq:04x}"
    trace_id = f"10ad{tag}".ljust(32, "0")[:32]
    root_id = f"407{tag}".ljust(16, "0")[:16]
    base = 1_791_907_200_000_000_000  # fixed epoch; uniqueness comes from ids
    spans: list[dict[str, object]] = [
        {
            "traceId": trace_id,
            "spanId": root_id,
            "name": "agent run",
            "kind": 1,
            "startTimeUnixNano": str(base),
            "endTimeUnixNano": str(base + 40_000_000_000),
            "attributes": [
                {"key": "apo.observation.type", "value": {"stringValue": "AGENT"}},
                {"key": "apo.trace.name", "value": {"stringValue": f"load {tag}"}},
            ],
        }
    ]
    for i in range(SPANS_PER_TRACE - 1):
        span_id = f"c{tag}{i:04x}".ljust(16, "0")
        start = base + 1_000_000_000 + i * 2_000_000_000
        end = start + 800_000_000
        is_gen = i % 2 == 0
        attrs = (
            [
                {"key": "apo.observation.type", "value": {"stringValue": "GENERATION"}},
                {
                    "key": "gen_ai.request.model",
                    "value": {"stringValue": "load/fake-model"},
                },
                {
                    "key": "gen_ai.usage.input_tokens",
                    "value": {"intValue": "1100"},
                },
                {
                    "key": "gen_ai.usage.output_tokens",
                    "value": {"intValue": "90"},
                },
            ]
            if is_gen
            else [
                {"key": "apo.observation.type", "value": {"stringValue": "TOOL"}},
                {"key": "gen_ai.tool.name", "value": {"stringValue": "bash"}},
                {
                    "key": "gen_ai.tool.call.arguments",
                    "value": {"stringValue": '{"command":"echo hi"}'},
                },
            ]
        )
        spans.append(
            {
                "traceId": trace_id,
                "spanId": span_id,
                "parentSpanId": root_id,
                "name": "gen" if is_gen else "tool",
                "kind": 1,
                "startTimeUnixNano": str(start),
                "endTimeUnixNano": str(end),
                "attributes": attrs,
            }
        )
    return spans


def payload_for(spans: list[dict[str, object]]) -> bytes:
    return json.dumps(
        {
            "resourceSpans": [
                {
                    "resource": {
                        "attributes": [
                            {
                                "key": "service.name",
                                "value": {"stringValue": "loadtest-svc"},
                            }
                        ]
                    },
                    "scopeSpans": [
                        {
                            "scope": {"name": "loadtest", "version": "1.0.0"},
                            "spans": spans,
                        }
                    ],
                }
            ]
        }
    ).encode()


def worker_run(
    port: int,
    key: str,
    worker: int,
    accepted: dict[str, int],
    lock: threading.Lock,
) -> None:
    url = f"http://127.0.0.1:{port}/api/public/otel/v1/traces"
    for seq in range(TRACES_PER_WORKER):
        body = payload_for(make_trace(worker, seq))
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                n = int(r.headers.get("X-Otlp-Accepted", "0"))
                with lock:
                    accepted["ok"] += n
                    if r.status != 200:
                        accepted["non200"] += 1
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:200]
            with lock:
                accepted["http_error"] += 1
            print(f"    worker {worker}: HTTP {e.code} {detail}", flush=True)
        except OSError as e:
            with lock:
                accepted["conn_error"] += 1
            print(f"    worker {worker}: {e}", flush=True)


def read_counts(db_path: Path) -> dict[str, object]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = con.cursor()
        canonical = cur.execute(
            "SELECT COUNT(*) FROM otlp_spans WHERE project_id = ?", (PROJECT_ID,)
        ).fetchone()[0]
        projected = cur.execute(
            "SELECT COUNT(*) FROM logged_calls WHERE project = ?", (PROJECT_ID,)
        ).fetchone()[0]
        runs = cur.execute(
            "SELECT COUNT(*) FROM runs WHERE project = ?", (PROJECT_ID,)
        ).fetchone()[0]
        batches = cur.execute(
            "SELECT status, COUNT(*), COALESCE(SUM(accepted_span_count), 0),"
            " COALESCE(SUM(rejected_span_count), 0) FROM otlp_ingest_batches"
            " WHERE project_id = ? GROUP BY status",
            (PROJECT_ID,),
        ).fetchall()
        errors = cur.execute(
            "SELECT status, error_message, COUNT(*) FROM otlp_ingest_batches"
            " WHERE project_id = ? AND status NOT IN ('projected')"
            " GROUP BY status, error_message LIMIT 5",
            (PROJECT_ID,),
        ).fetchall()
        return {
            "canonical": canonical,
            "projected": projected,
            "runs": runs,
            "batches": batches,
            "errors": errors,
        }
    finally:
        con.close()


def wait_drained(db_path: Path, port: int, timeout: float = DRAIN_TIMEOUT_S) -> bool:
    """Wait until no non-terminal batches AND projected count is stable."""
    deadline = time.monotonic() + timeout
    last = -1
    stable_since: float | None = None
    while time.monotonic() < deadline:
        counts = read_counts(db_path)
        non_terminal = [
            (s, n) for s, n, _, _ in counts["batches"] if s in ("queued", "processing")
        ]  # type: ignore[misc]
        projected = int(counts["projected"])  # type: ignore[misc]
        if not non_terminal and projected == last and last >= 0:
            if stable_since is None:
                stable_since = time.monotonic()
            elif time.monotonic() - stable_since >= 2.0:
                return True
        else:
            stable_since = None
        last = projected
        time.sleep(0.5)
    return False


def run_level(concurrency: int, keep_dir: Path | None) -> tuple[bool, dict[str, object]]:
    scratch = keep_dir or Path(f"/tmp/apo-loadtest-{concurrency}-{int(time.time())}")
    scratch.mkdir(parents=True, exist_ok=True)
    db_path = scratch / "apo.db"
    port = free_port()
    log_path = scratch / "backend.log"

    env = dict(SERVER_ENV)
    env["DATABASE_URL"] = f"sqlite:///{db_path}"
    log_file = open(log_path, "wb")
    server = subprocess.Popen(
        [
            "uv",
            "run",
            "uvicorn",
            "apo.api:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=BACKEND,
        env={**{k: v for k, v in __import__("os").environ.items()}, **env},
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    try:
        wait_healthy(port)
        key = seed(db_path)

        expected = concurrency * TRACES_PER_WORKER * SPANS_PER_TRACE
        accepted: dict[str, int] = {"ok": 0, "non200": 0, "http_error": 0, "conn_error": 0}
        lock = threading.Lock()
        threads = [
            threading.Thread(target=worker_run, args=(port, key, w, accepted, lock))
            for w in range(concurrency)
        ]
        t0 = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        send_s = time.monotonic() - t0

        drained = wait_drained(db_path, port)
        counts = read_counts(db_path)

        loss = int(accepted["ok"]) - int(counts["projected"])  # type: ignore[misc]
        canonical_gap = int(accepted["ok"]) - int(counts["canonical"])  # type: ignore[misc]
        accept_gap = expected - int(accepted["ok"])
        ok = (
            drained
            and loss == 0
            and canonical_gap == 0
            and accept_gap == 0
            and accepted["http_error"] == 0
            and accepted["conn_error"] == 0
            and accepted["non200"] == 0
        )
        print(f"  level={concurrency} workers sent {expected} spans in {send_s:.1f}s")
        print(
            f"  accepted={accepted['ok']} canonical={counts['canonical']}"
            f" projected={counts['projected']} runs={counts['runs']}"
            f" drained={drained}"
        )
        print(f"  batches={counts['batches']}")
        if counts["errors"]:  # type: ignore[misc]
            print(f"  batch errors (status, message, count)={counts['errors']}")
        print(
            f"  VERDICT level={concurrency}: "
            f"{'PASS' if ok else 'FAIL'}"
            f" (projection_loss={loss}, accept_loss={canonical_gap},"
            f" rejected_at_door={accept_gap},"
            f" http_errors={accepted['http_error']}, conn_errors={accepted['conn_error']})"
        )
        if keep_dir is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
            log_file.close()
        else:
            log_file.close()
            print(f"  kept scratch stack: {scratch} (db + backend.log)")
        return ok, {"accepted": accepted, "counts": counts, "loss": loss}
    finally:
        if keep_dir is None:
            if server.poll() is None:
                server.kill()
            log_file.close()


def main() -> int:
    global TRACES_PER_WORKER, SPANS_PER_TRACE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-c",
        "--concurrency",
        type=int,
        action="append",
        default=None,
        help="concurrency level (repeatable; default 5 and 20)",
    )
    parser.add_argument(
        "--traces",
        type=int,
        default=None,
        help="traces (OTLP requests) each worker sends (default 4)",
    )
    parser.add_argument(
        "--spans",
        type=int,
        default=None,
        help="spans per trace/request, one large batch (default 256)",
    )
    parser.add_argument(
        "--keep", action="store_true", help="keep scratch dir + server running"
    )
    args = parser.parse_args()
    if args.traces:
        TRACES_PER_WORKER = args.traces
    if args.spans:
        SPANS_PER_TRACE = args.spans
    levels = args.concurrency or [5, 20]

    results: list[tuple[int, bool]] = []
    for level in levels:
        print(f"== concurrency {level} ==", flush=True)
        ok, _ = run_level(level, Path(f"/tmp/apo-loadtest-{level}") if args.keep else None)
        results.append((level, ok))

    print("\n== summary ==")
    for level, ok in results:
        print(f"  concurrency {level}: {'PASS' if ok else 'FAIL'}")
    all_ok = all(ok for _, ok in results)
    print(f"projection loss {'ZERO' if all_ok else 'NONZERO'}")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
