"""
Tests for the comments API (SPEC-056).

Test cases:
1. Create comment on trace
2. Create comment with missing fields returns 400
3. Create comment with empty content returns 400
4. List comments for an object
5. List comments returns empty for unknown object
6. Delete comment removes it
7. Delete nonexistent comment returns 404
8. Toggle reaction adds reaction
9. Toggle reaction again removes reaction (toggle off)
10. Toggle reaction on nonexistent comment returns 404
11. Toggle reaction with missing fields returns 400
12. Get comment counts for multiple objects
13. Get comment counts with empty IDs returns empty
14. Delete comment also deletes its reactions
"""

from fastapi.testclient import TestClient


class TestCreateComment:
    def test_create_comment_on_trace(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "This trace shows a hallucination",
                "project_id": "proj-1",
                "author_id": "user-1",
                "author_name": "Alice",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["object_id"] == "trace-1"
        assert data["object_type"] == "trace"
        assert data["content"] == "This trace shows a hallucination"
        assert data["author_name"] == "Alice"
        assert data["reactions"] == []
        assert data["id"] is not None
        assert data["created_at"] is not None

    def test_create_comment_on_observation(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "obs-1",
                "object_type": "observation",
                "content": "Check this step",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["object_type"] == "observation"

    def test_create_comment_missing_fields(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/comments",
            json={"content": "hello"},
        )
        assert resp.status_code == 400

    def test_create_comment_empty_content(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "   ",
            },
        )
        assert resp.status_code == 400

    def test_create_comment_strips_whitespace(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "  hello world  ",
            },
        )
        assert resp.status_code == 201
        assert resp.json()["content"] == "hello world"


class TestListComments:
    def test_list_comments_returns_created(self, client: TestClient) -> None:
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "First comment",
            },
        )
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "Second comment",
            },
        )

        resp = client.get(
            "/api/v1/comments",
            params={"object_id": "trace-1", "object_type": "trace"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["content"] == "First comment"
        assert data[1]["content"] == "Second comment"

    def test_list_comments_empty_for_unknown(self, client: TestClient) -> None:
        resp = client.get(
            "/api/v1/comments",
            params={"object_id": "nonexistent", "object_type": "trace"},
        )
        assert resp.status_code == 200
        assert resp.json() == []

    def test_list_comments_filters_by_object_type(self, client: TestClient) -> None:
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "obj-1",
                "object_type": "trace",
                "content": "Trace comment",
            },
        )
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "obj-1",
                "object_type": "observation",
                "content": "Obs comment",
            },
        )

        resp = client.get(
            "/api/v1/comments",
            params={"object_id": "obj-1", "object_type": "trace"},
        )
        data = resp.json()
        assert len(data) == 1
        assert data[0]["content"] == "Trace comment"


class TestDeleteComment:
    def test_delete_comment(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "To delete",
            },
        )
        comment_id = create_resp.json()["id"]

        resp = client.delete(f"/api/v1/comments/{comment_id}")
        assert resp.status_code == 204

        list_resp = client.get(
            "/api/v1/comments",
            params={"object_id": "trace-1", "object_type": "trace"},
        )
        assert list_resp.json() == []

    def test_delete_nonexistent_returns_404(self, client: TestClient) -> None:
        resp = client.delete("/api/v1/comments/nonexistent-id")
        assert resp.status_code == 404

    def test_delete_comment_removes_reactions(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "With reaction",
            },
        )
        comment_id = create_resp.json()["id"]

        client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "👍", "user_id": "user-1"},
        )

        resp = client.delete(f"/api/v1/comments/{comment_id}")
        assert resp.status_code == 204


class TestToggleReaction:
    def test_add_reaction(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "React to this",
            },
        )
        comment_id = create_resp.json()["id"]

        resp = client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "👍", "user_id": "user-1"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["reactions"]) == 1
        assert data["reactions"][0]["emoji"] == "👍"
        assert data["reactions"][0]["user_ids"] == ["user-1"]

    def test_toggle_off_reaction(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "Toggle off",
            },
        )
        comment_id = create_resp.json()["id"]

        client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "👍", "user_id": "user-1"},
        )

        resp = client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "👍", "user_id": "user-1"},
        )
        assert resp.status_code == 200
        assert resp.json()["reactions"] == []

    def test_multiple_users_same_emoji(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "Multi react",
            },
        )
        comment_id = create_resp.json()["id"]

        client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "❤️", "user_id": "user-1"},
        )
        resp = client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "❤️", "user_id": "user-2"},
        )
        data = resp.json()
        assert len(data["reactions"]) == 1
        assert sorted(data["reactions"][0]["user_ids"]) == ["user-1", "user-2"]

    def test_reaction_nonexistent_comment(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/comments/nonexistent/reactions",
            json={"emoji": "👍", "user_id": "user-1"},
        )
        assert resp.status_code == 404

    def test_reaction_missing_fields(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "test",
            },
        )
        comment_id = create_resp.json()["id"]

        resp = client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "👍"},
        )
        assert resp.status_code == 400


class TestGetCommentCounts:
    def test_counts_for_multiple_objects(self, client: TestClient) -> None:
        for _ in range(3):
            client.post(
                "/api/v1/comments",
                json={
                    "object_id": "trace-1",
                    "object_type": "trace",
                    "content": "comment",
                },
            )
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-2",
                "object_type": "trace",
                "content": "comment",
            },
        )

        resp = client.get(
            "/api/v1/comments/counts",
            params={"object_ids": "trace-1,trace-2,trace-3", "object_type": "trace"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["trace-1"] == 3
        assert data["trace-2"] == 1
        assert data["trace-3"] == 0

    def test_counts_empty_ids(self, client: TestClient) -> None:
        resp = client.get(
            "/api/v1/comments/counts",
            params={"object_ids": "", "object_type": "trace"},
        )
        assert resp.status_code == 200
        assert resp.json() == {}

    def test_counts_filters_by_object_type(self, client: TestClient) -> None:
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "obj-1",
                "object_type": "trace",
                "content": "trace comment",
            },
        )
        client.post(
            "/api/v1/comments",
            json={
                "object_id": "obj-1",
                "object_type": "observation",
                "content": "obs comment",
            },
        )

        resp = client.get(
            "/api/v1/comments/counts",
            params={"object_ids": "obj-1", "object_type": "trace"},
        )
        assert resp.json()["obj-1"] == 1


class TestCommentFullWorkflow:
    def test_create_react_delete_workflow(self, client: TestClient) -> None:
        create_resp = client.post(
            "/api/v1/comments",
            json={
                "object_id": "trace-1",
                "object_type": "trace",
                "content": "Full workflow test",
                "author_name": "Bob",
            },
        )
        assert create_resp.status_code == 201
        comment = create_resp.json()
        comment_id = comment["id"]

        client.post(
            f"/api/v1/comments/{comment_id}/reactions",
            json={"emoji": "🎉", "user_id": "user-1"},
        )

        list_resp = client.get(
            "/api/v1/comments",
            params={"object_id": "trace-1", "object_type": "trace"},
        )
        data = list_resp.json()
        assert len(data) == 1
        assert len(data[0]["reactions"]) == 1
        assert data[0]["author_name"] == "Bob"

        counts_resp = client.get(
            "/api/v1/comments/counts",
            params={"object_ids": "trace-1", "object_type": "trace"},
        )
        assert counts_resp.json()["trace-1"] == 1

        client.delete(f"/api/v1/comments/{comment_id}")

        counts_resp2 = client.get(
            "/api/v1/comments/counts",
            params={"object_ids": "trace-1", "object_type": "trace"},
        )
        assert counts_resp2.json()["trace-1"] == 0
