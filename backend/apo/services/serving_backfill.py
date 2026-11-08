"""Bounded, resumable serving-identity metadata backfill.

Derives serving identity columns for already-ingested traces by replaying
their retained canonical spans through the projector in ``cost_mode=
"preserve"``: every stored price and cost field stays byte-identical, only
identity, accounting, scope, and timing metadata refresh. Running it twice
produces identical derived fields. Raw canonical evidence is never touched.

Operator entry point::

    python -m apo.services.serving_backfill --project P --limit 100 --after CURSOR

prints a single JSON result ``{"traces_scanned": n, "observations_updated":
n, "next_cursor": "..." | null}``. ``next_cursor`` is the next trace key;
pass it back as ``--after`` to resume. A null cursor means the project is
exhausted. Scans one explicit project only; no startup-wide scan, no
provider network lookups.
"""

# pyright: reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import argparse
import json
import logging

from sqlmodel import Session, col, select

from ..db import engine
from ..models.db import OtlpSpanDB
from .reproject import reproject_trace

logger = logging.getLogger(__name__)


def backfill_serving_identity(
    project_id: str,
    *,
    limit: int = 100,
    after: str | None = None,
) -> dict[str, int | str | None]:
    """Backfill serving metadata for up to ``limit`` traces after ``after``.

    Keyset pagination over distinct trace ids, so a resumed run never
    re-selects the first N traces.
    """
    with Session(engine) as session:
        statement = (
            select(col(OtlpSpanDB.trace_id))
            .where(OtlpSpanDB.project_id == project_id)
            .distinct()
            .order_by(col(OtlpSpanDB.trace_id))
        )
        if after is not None:
            statement = statement.where(col(OtlpSpanDB.trace_id) > after)
        trace_ids = session.exec(statement.limit(limit)).all()

    traces_scanned = 0
    observations_updated = 0
    for trace_id in trace_ids:
        traces_scanned += 1
        observations_updated += reproject_trace(
            trace_id, project_id, cost_mode="preserve"
        )

    next_cursor: str | None = None
    if traces_scanned == limit and trace_ids:
        next_cursor = trace_ids[-1]

    return {
        "traces_scanned": traces_scanned,
        "observations_updated": observations_updated,
        "next_cursor": next_cursor,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill serving identity metadata without touching costs"
    )
    parser.add_argument("--project", required=True, help="Project id to scan")
    parser.add_argument(
        "--limit", type=int, default=100, help="Max traces to process this run"
    )
    parser.add_argument(
        "--after", default=None, help="Resume cursor (previous next_cursor)"
    )
    args = parser.parse_args()
    result = backfill_serving_identity(
        args.project, limit=args.limit, after=args.after
    )
    print(json.dumps(result))


if __name__ == "__main__":
    main()
