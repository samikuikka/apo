# pyright: reportAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportPrivateLocalImportUsage=false, reportUnnecessaryTypeIgnoreComment=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedParameter=false

"""Maintenance-loop visibility (ready-to-invite 4.4).

The daily loop's pass summary is persisted in the one-row
``maintenance_state`` table and surfaced by ``GET /v1/admin/retention`` —
it used to be discarded, so an operator could not tell the loop ever ran.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.models.db import MaintenanceStateDB
from tests.conftest import engine
from apo.services.retention import _run_and_record_maintenance_pass


def _record_pass(summary: dict[str, int]) -> None:
    """Drive the record path without waiting for the daily loop.

    Binds the module's engine to the conftest engine (same as the webhook
    delivery tests): the helper writes through the production engine
    import, which is a different database than the test schema.
    """
    from tests.conftest import engine as test_engine

    from apo.services import retention as retention_module

    original_cleanup = retention_module.run_maintenance_cleanup
    original_engine = retention_module.engine
    retention_module.run_maintenance_cleanup = lambda: summary
    retention_module.engine = test_engine
    try:
        _run_and_record_maintenance_pass()
    finally:
        retention_module.run_maintenance_cleanup = original_cleanup
        retention_module.engine = original_engine


def test_pass_is_recorded_as_one_overwritten_row(session: Session):
    _record_pass({"blanked_payloads": 3})
    _record_pass({"blanked_payloads": 5})

    with Session(engine) as check:
        rows = check.exec(select(MaintenanceStateDB)).all()
        assert len(rows) == 1, "maintenance state must stay a single row"
        row = rows[0]
        assert row.id == 1
        assert row.summary == {"blanked_payloads": 5}
        assert row.last_started_at is not None
        assert row.last_finished_at is not None
        assert isinstance(row.duration_ms, int)


def test_retention_endpoint_surfaces_maintenance_state(
    session: Session, client: TestClient
):
    from apo.services import retention as retention_module

    # The endpoint's DB-size and queue-depth helpers query the production
    # module engine (no test schema there — a pre-existing test-env quirk,
    # and why no test covered this endpoint before); stub them so the scene
    # proves the maintenance field's wiring on the request session.
    with (
        patch("apo.routes.admin.ADMIN_API_KEY", "test-admin-key"),
        patch.object(retention_module, "get_db_size_info", return_value={}),
        patch.object(retention_module, "get_db_table_sizes", return_value={}),
        patch("apo.services.trace_ingestion_queue.queue_depth_report", return_value={}),
    ):
        # Before any recorded pass: the key exists and is null.
        resp = client.get(
            "/v1/admin/retention", headers={"x-admin-key": "test-admin-key"}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["maintenance"] is None

        _record_pass({"blanked_payloads": 1, "reaped_tokens": 2})

        resp = client.get(
            "/v1/admin/retention", headers={"x-admin-key": "test-admin-key"}
        )
        assert resp.status_code == 200, resp.text
        maintenance = resp.json()["maintenance"]
        assert maintenance is not None
        assert maintenance["summary"] == {"blanked_payloads": 1, "reaped_tokens": 2}
        assert maintenance["last_finished_at"] is not None
        assert isinstance(maintenance["duration_ms"], int)


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main(["-v", __file__]))
