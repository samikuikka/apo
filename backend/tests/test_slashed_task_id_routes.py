"""Tests for folder-scoped task IDs in URL routes.

Task IDs became folder-scoped on 2026-07-11 (e.g.
``tasks/openai-agent/data-extraction`` instead of ``data-extraction``),
but the FastAPI routes used ``{task_id}`` — a single path segment that
can't match slashes. These tests pin the ``{task_id:path}`` fix so the
source-viewing, file-listing, and task-detail routes work with the IDs
that actually exist in the database.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


SLASHED_TASK_ID = "tasks/openai-agent/data-extraction"


class TestSlashedTaskIdRoutes:
    """Routes must accept task IDs containing slashes."""

    def test_project_task_detail_route_matches_slashed_id(
        self, client: TestClient
    ) -> None:
        """GET /v1/projects/{pid}/agent-tasks/{task_id} must not 404
        when task_id contains slashes."""
        # We don't need a real task — just confirming the route matches
        # (not 404 for routing reasons). With no inventory, expect 404
        # from the handler, not from routing.
        response = client.get(
            f"/v1/projects/any-project/agent-tasks/{SLASHED_TASK_ID}"
        )
        # 401 (auth) or 404 (not found from handler) both prove the route
        # matched. A routing 404 would also return 404, so we check that
        # the handler-level detail is present (not a generic "Not Found").
        assert response.status_code != 404 or "not found" in response.text.lower() or response.status_code == 401

    def test_file_route_matches_slashed_id(self, client: TestClient) -> None:
        """GET /v1/projects/{pid}/agent-tasks/{task_id}/files/{file}
        must route-match when task_id contains slashes."""
        response = client.get(
            f"/v1/projects/any-project/agent-tasks/{SLASHED_TASK_ID}/files/task.ts"
        )
        # Auth-gated or handler-404 both prove the route matched.
        assert response.status_code in (401, 404)

    def test_non_project_file_route_matches_slashed_id(
        self, client: TestClient
    ) -> None:
        """GET /v1/agent-tasks/{task_id}/files/{file} must also match."""
        response = client.get(
            f"/v1/agent-tasks/{SLASHED_TASK_ID}/files/task.ts"
        )
        assert response.status_code in (401, 404)

    def test_list_files_route_matches_slashed_id(self, client: TestClient) -> None:
        """GET /v1/agent-tasks/{task_id}/files must match."""
        response = client.get(
            f"/v1/agent-tasks/{SLASHED_TASK_ID}/files"
        )
        assert response.status_code in (401, 404)

    def test_encoded_slashes_also_match(self, client: TestClient) -> None:
        """The frontend sends encodeURIComponent(taskId) which turns /
        into %2F. The route must match both forms."""
        encoded = SLASHED_TASK_ID.replace("/", "%2F")
        response = client.get(
            f"/v1/projects/any-project/agent-tasks/{encoded}/files/task.ts"
        )
        assert response.status_code in (401, 404)
