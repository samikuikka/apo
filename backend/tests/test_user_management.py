# pyright: reportAny=false, reportPrivateUsage=false, reportUnusedCallResult=false

from typing import Any

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo.auth import verify_password
from apo.models.db import UserDB


def _setup_admin_authed(
    client: TestClient, session: Session, make_authed_client: Any
) -> tuple[TestClient, str]:
    """Create admin user via the public setup endpoint and return an authed client.

    SPEC-122: the first signup is no longer auto-admin. These tests
    cover the instance-maintenance ``/auth/users`` endpoints, which
    still require ``UserDB.is_admin``. We flip the flag directly in the
    DB to exercise that path.
    """
    resp = client.post(
        "/auth/setup",
        json={"email": "admin@test.com", "password": "AdminPass123", "name": "Admin"},
    )
    assert resp.status_code == 200
    admin_user = session.exec(select(UserDB)).first()
    assert admin_user is not None
    admin_user.is_admin = True
    session.add(admin_user)
    session.commit()
    session.refresh(admin_user)
    return make_authed_client(admin_user.id, session), admin_user.id


class TestListUsers:
    def test_list_users_returns_all(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.get("/auth/users")
        assert resp.status_code == 200
        data = resp.json()
        assert "users" in data
        assert len(data["users"]) == 1
        user = data["users"][0]
        assert user["email"] == "admin@test.com"
        assert user["is_admin"] is True
        assert user["is_active"] is True
        assert "id" in user
        assert "created_at" in user

    def test_list_users_after_setup_only(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.get("/auth/users")
        assert resp.status_code == 200
        users = resp.json()["users"]
        assert len(users) == 1
        assert users[0]["email"] == "admin@test.com"

    def test_list_users_non_admin_blocked(self, client: TestClient) -> None:
        resp = client.get("/auth/users")
        # SPEC-122: unauthenticated requests are blocked at the auth
        # middleware (401) before reaching the admin check (403). Either
        # status is acceptable for "blocked".
        assert resp.status_code in (401, 403)


class TestInviteUser:
    def test_invite_creates_new_user(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.post(
            "/auth/users",
            json={"email": "new@test.com", "name": "New User", "password": "NewPass123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["email"] == "new@test.com"
        assert data["name"] == "New User"
        assert data["is_admin"] is False
        assert data["is_active"] is True
        assert "id" in data

    def test_invite_user_stores_hashed_password(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        authed.post(
            "/auth/users",
            json={"email": "new@test.com", "name": "New", "password": "NewPass123"},
        )

        user = session.exec(
            select(UserDB).where(UserDB.email == "new@test.com")
        ).first()
        assert user is not None
        assert verify_password("NewPass123", user.password_hash)

    def test_invite_weak_password_rejected(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.post(
            "/auth/users",
            json={"email": "new@test.com", "name": "New", "password": "short"},
        )
        assert resp.status_code == 422

    def test_invite_duplicate_email_returns_409(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.post(
            "/auth/users",
            json={"email": "admin@test.com", "name": "Dup", "password": "Pass1234"},
        )
        assert resp.status_code == 409
        assert "already exists" in resp.json()["detail"]

    def test_invite_non_admin_blocked(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/users",
            json={"email": "new@test.com", "name": "New", "password": "Pass1234"},
        )
        # SPEC-122: blocked at middleware (401) or admin check (403).
        assert resp.status_code in (401, 403)


class TestUpdateUser:
    def test_toggle_admin(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Member", "password": "Pass1234"},
        )
        member = invite_resp.json()

        resp = authed.patch(
            f"/auth/users/{member['id']}",
            json={"is_admin": True},
        )
        assert resp.status_code == 200
        assert resp.json()["is_admin"] is True

    def test_update_name(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Old Name", "password": "Pass1234"},
        )
        member = invite_resp.json()

        resp = authed.patch(
            f"/auth/users/{member['id']}",
            json={"name": "New Name"},
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "New Name"

    def test_self_demotion_blocked(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, admin_id = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.patch(
            f"/auth/users/{admin_id}",
            json={"is_admin": False},
        )
        assert resp.status_code == 403
        assert "own admin role" in resp.json()["detail"]

    def test_update_nonexistent_returns_404(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.patch(
            "/auth/users/nonexistent-id",
            json={"name": "Ghost"},
        )
        assert resp.status_code == 404

    def test_update_empty_body_no_change(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Member", "password": "Pass1234"},
        )
        member = invite_resp.json()

        resp = authed.patch(
            f"/auth/users/{member['id']}",
            json={},
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "Member"
        assert resp.json()["is_admin"] is False

    def test_update_non_admin_blocked(self, client: TestClient) -> None:
        resp = client.patch(
            "/auth/users/some-id",
            json={"name": "Hacked"},
        )
        # SPEC-122: blocked at middleware (401) or admin check (403).
        assert resp.status_code in (401, 403)


class TestDeactivateUser:
    def test_deactivate_sets_inactive(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Member", "password": "Pass1234"},
        )
        member = invite_resp.json()

        resp = authed.delete(f"/auth/users/{member['id']}")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True

        user = session.get(UserDB, member["id"])
        assert user is not None
        assert user.is_active is False

    def test_self_deactivation_blocked(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, admin_id = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.delete(f"/auth/users/{admin_id}")
        assert resp.status_code == 403
        assert "own account" in resp.json()["detail"]

    def test_deactivate_nonexistent_returns_404(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        resp = authed.delete("/auth/users/nonexistent-id")
        assert resp.status_code == 404

    def test_deactivate_non_admin_blocked(self, client: TestClient) -> None:
        resp = client.delete("/auth/users/some-id")
        # SPEC-122: blocked at middleware (401) or admin check (403).
        assert resp.status_code in (401, 403)


class TestDeactivatedUserAuth:
    def test_deactivated_user_cannot_verify_password(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)
        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Member", "password": "Pass1234"},
        )
        member = invite_resp.json()

        authed.delete(f"/auth/users/{member['id']}")

        resp = client.post(
            "/auth/verify-password",
            json={"email": "member@test.com", "password": "Pass1234"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid credentials"


class TestFullWorkflow:
    def test_invite_toggle_deactivate(
        self, client: TestClient, session: Session, make_authed_client: Any
    ) -> None:
        authed, _ = _setup_admin_authed(client, session, make_authed_client)

        list_resp = authed.get("/auth/users")
        assert len(list_resp.json()["users"]) == 1

        invite_resp = authed.post(
            "/auth/users",
            json={"email": "member@test.com", "name": "Member", "password": "Pass1234"},
        )
        assert invite_resp.status_code == 200
        member_id = invite_resp.json()["id"]

        list_resp2 = authed.get("/auth/users")
        assert len(list_resp2.json()["users"]) == 2

        toggle_resp = authed.patch(
            f"/auth/users/{member_id}",
            json={"is_admin": True},
        )
        assert toggle_resp.status_code == 200
        assert toggle_resp.json()["is_admin"] is True

        toggle_resp2 = authed.patch(
            f"/auth/users/{member_id}",
            json={"is_admin": False},
        )
        assert toggle_resp2.status_code == 200
        assert toggle_resp2.json()["is_admin"] is False

        deactivate_resp = authed.delete(f"/auth/users/{member_id}")
        assert deactivate_resp.status_code == 200

        list_resp3 = authed.get("/auth/users")
        member_in_list = [u for u in list_resp3.json()["users"] if u["id"] == member_id]
        assert len(member_in_list) == 1
        assert member_in_list[0]["is_active"] is False
