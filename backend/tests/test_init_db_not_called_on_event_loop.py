"""``init_db`` must never be called directly from async code.

The migration ladder is ordinary synchronous code, and its v26 step drives an
``async`` placement helper with ``asyncio.run``. ``asyncio.run`` refuses to
start a loop when one is already running in the same thread, so calling
``init_db`` inline from an ``async def`` crashes with "asyncio.run() cannot be
called from a running event loop" — which is exactly what happened in
``lifespan``, taking down startup for every database upgrading through v26
with legacy deliverable blobs.

Async callers must hand it to a worker instead::

    await asyncio.to_thread(init_db)

This is a source-level guard rather than a behavioural one on purpose: driving
the real ``lifespan`` in-process starts the schedulers, retention loop, trace
ingestion worker, and lease reaper, which leak into the rest of the suite. The
rule being protected is structural, so the check is too — same approach as
``test_no_removed_execution_symbols``.
"""

from __future__ import annotations

import ast
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1] / "apo"


def _direct_async_calls() -> list[tuple[str, int]]:
    """Every ``init_db()`` call that sits inside an ``async def``.

    A bare call is ``Call(func=Name('init_db'))``. Passing the function to a
    worker — ``asyncio.to_thread(init_db)`` — puts ``init_db`` in an argument
    as a plain ``Name``, so the two forms never get confused.
    """
    offenders: list[tuple[str, int]] = []
    for py_file in _BACKEND.rglob("*.py"):
        tree = ast.parse(py_file.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.AsyncFunctionDef):
                continue
            for inner in ast.walk(node):
                if (
                    isinstance(inner, ast.Call)
                    and isinstance(inner.func, ast.Name)
                    and inner.func.id == "init_db"
                ):
                    rel = str(py_file.relative_to(_BACKEND))
                    offenders.append((rel, inner.lineno))
    return offenders


def test_init_db_is_never_called_inline_from_async_code() -> None:
    offenders = _direct_async_calls()
    assert not offenders, (
        "init_db() called directly inside an async def — the v26 backfill's "
        + "asyncio.run will raise there. Use `await asyncio.to_thread(init_db)`:\n"
        + "\n".join(f"  {f}:{n}" for f, n in offenders)
    )


def test_lifespan_hands_init_db_to_a_worker_thread() -> None:
    """The startup path keeps the hand-off, so the guard above stays meaningful."""
    tree = ast.parse((_BACKEND / "api.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "to_thread"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "asyncio"
            and any(isinstance(arg, ast.Name) and arg.id == "init_db" for arg in node.args)
        ):
            return
    raise AssertionError(
        "api.py no longer hands init_db to a worker thread"
        " (expected a call `asyncio.to_thread(init_db, ...)`)"
    )
