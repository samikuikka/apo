"""Generate demo traffic against the orders API (traces without runs).

Run the service first::

    cd apps/example-service-py
    uv run uvicorn app.main:app --port 3002

Then::

    uv run python scripts/seed_demo_traces.py

Sends a realistic mix — successful lists/creates, a few 404s, a 422, and a
couple of provider-failure 500s — across customer tiers, so the resulting
traces demonstrate apo's service-trace search (filter by service, by
``customer.tier``, by ``http.status_code >= 500``).
"""

from __future__ import annotations

import asyncio
import random
import sys

import httpx

BASE = "http://localhost:3002"
TIERS = ("enterprise", "pro", "free", "enterprise", "pro")
random.seed(42)


async def main() -> int:
    ok = fail = 0
    async with httpx.AsyncClient(base_url=BASE, timeout=10) as client:
        # Successful list requests across tiers (each → one trace with a
        # db.query child span).
        for i, tier in enumerate(TIERS * 4):
            r = await client.get("/api/orders", headers={"X-Customer-Tier": tier})
            ok += r.status_code == 200
            await asyncio.sleep(random.uniform(0.02, 0.08))

        # Fetches: known ids plus 404s.
        for oid in ("ord-1001", "ord-1002", "ord-1003", "ord-9999", "ord-8888", "ord-1001"):
            r = await client.get(f"/api/orders/{oid}")
            ok += r.status_code == 200
            fail += r.status_code == 404

        # Creates: valid, one invalid (422), two provider failures (500).
        creates = [
            ("desk lamp", 45.0, "enterprise"),
            ("standing desk", 590.0, "pro"),
            ("", -5.0, "free"),          # validation failure → 422
            ("fail-charged-cable", 12.0, "enterprise"),  # provider outage → 500
            ("usb hub", 29.0, "free"),
            ("failed-monitor", 300.0, "pro"),            # provider outage → 500
        ]
        for item, total, tier in creates:
            try:
                r = await client.post(
                    "/api/orders",
                    json={"item": item, "total": total},
                    headers={"X-Customer-Tier": tier},
                )
                ok += r.status_code == 201
                fail += r.status_code >= 400
            except httpx.HTTPError:
                fail += 1
            await asyncio.sleep(random.uniform(0.03, 0.1))

    print(f"sent requests: ok={ok} non-2xx={fail}")
    print("traces now in apo: filter service=orders-api, or attribute:http.status_code>=500")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
