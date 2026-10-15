# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false

"""The catalog digest must be identical in Python and TypeScript.

``apo connect`` hashes its local catalog with the CLI's
``computeCatalogDigest`` and claims gate on equality with the server's
stored digest, so the two implementations share one canonical form: tasks
ordered by ``task_id`` in Unicode code-point order, keys sorted, compact
separators, characters raw (``ensure_ascii=False``). The literals below were
produced by the TypeScript implementation (verified against
``packages/cli/tests/task-catalog-digest.test.ts``); if either side drifts,
an executor holding the identical catalog reports a spurious
``catalog_mismatch``.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from apo.services.task_catalog import compute_catalog_digest


def _task(
    task_id: str,
    display_name: str,
    *,
    folder_path: str = "",
    adapter_name: str = "x",
    has_checks: bool = True,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "display_name": display_name,
        "task_path": task_id,
        "folder_path": folder_path,
        "adapter_name": adapter_name,
        "has_checks": has_checks,
        "tags": sorted(tags or []),
    }


# (name, tasks, digest computed by the TypeScript twin)
CASES = [
    (
        "ascii",
        [_task("connect-fixture", "connect-fixture")],
        "sha256:bd8001ea07d09cae7acddc06ecf372f4309c95880fcc1ed91532b7475f3a7e14",
    ),
    (
        # Code point orders "Support/..." (S = 0x53) before "admin/..."
        # (a = 0x61); locale collation orders them the other way around, so
        # this fixture pins the ordering, not just the escaping.
        "mixed-case ids",
        [
            _task("admin/report", "Report a problem", folder_path="admin"),
            _task("Support/refund", "Issue a refund", folder_path="Support"),
        ],
        "sha256:1a1bbd7eeb04e947bc2e01e13844866682d0f11bbdbc1ae92423b163a5a02df6",
    ),
    (
        "non-ascii text",
        [_task("équipe/check", "Résumé review", tags=["wiedza", "tägi"])],
        "sha256:37e88cfb9d40ca3c679924403237221e3e4139a9530131836b4cc72f2d716031",
    ),
    (
        # An astral-plane id after a BMP id: UTF-8 byte order (the CLI's
        # comparator) and code-point order (Python's sort) must agree.
        "astral-plane id",
        [
            _task(
                "\U0001f680/deploy",
                "Ship it",
                folder_path="\U0001f680",
                has_checks=False,
                tags=["🎨"],
            ),
            _task("Zebra/plain", "Last in code-point order", folder_path="Zebra", has_checks=False),
        ],
        "sha256:0f4ecb913df95f992005f16a81c0814ff085e812fc7a9557d038c9b101935dee",
    ),
]


@pytest.mark.parametrize(
    ("name", "tasks", "expected"), CASES, ids=[case[0] for case in CASES]
)
def test_matches_the_typescript_digest(name: str, tasks: list[dict[str, Any]], expected: str) -> None:
    assert compute_catalog_digest(tasks) == expected


def test_input_order_does_not_change_the_digest() -> None:
    tasks = CASES[1][1]
    assert compute_catalog_digest(list(reversed(tasks))) == compute_catalog_digest(tasks)


def test_ascii_escaping_would_break_parity() -> None:
    """The pre-canonical form (``ensure_ascii=True``) hashed ``\\u00e9``
    escapes while the CLI hashed raw UTF-8; pin that the two serializations
    genuinely differ over non-ASCII so the default can never quietly come
    back and match an ASCII-only test suite."""
    tasks = CASES[2][1]
    doc = {"schema_version": 1, "tasks": sorted(tasks, key=lambda t: t["task_id"])}
    escaped = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    raw = json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert escaped != raw
    assert "\\u00e9" in escaped
    assert "é" in raw
