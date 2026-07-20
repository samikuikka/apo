import asyncio
import inspect
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from apo.api import app
from apo.db import get_session
from apo.models.db import ProjectDB, ProjectMembershipDB

# A stable project id used across the API-key tests. Issue #11 tightened
# mint paths to require a real ProjectDB row, so tests that mint keys must
# seed this project (and make the caller its owner) before POSTing.
TEST_PROJECT_ID = "example-service"


def seed_project_for_user(
    session: Session, owner_id: str, *, project_id: str = TEST_PROJECT_ID
) -> str:
    """Insert a real ProjectDB row + owner membership, return its id.

    Used by API-key / bootstrap tests so the strict project-role check
    (issue #11) passes. Idempotent: if the project already exists, the
    membership is still ensured.
    """
    project = session.get(ProjectDB, project_id)
    if project is None:
        project = ProjectDB(
            id=project_id,
            name=project_id,
            created_by=owner_id,
            created_at=datetime.now(timezone.utc),
        )
        session.add(project)
        session.commit()
        session.refresh(project)
    if (
        session.exec(
            select(ProjectMembershipDB).where(
                ProjectMembershipDB.project_id == project_id,
                ProjectMembershipDB.user_id == owner_id,
            )
        ).first()
        is None
    ):
        now = datetime.now(timezone.utc)
        session.add(
            ProjectMembershipDB(
                project_id=project_id,
                user_id=owner_id,
                role="owner",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
    return project_id


# Setup in-memory DB
# StaticPool is required for in-memory SQLite to share the same DB across connections
# Use check_same_thread=False to allow pytest to access it from different threads if needed
engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

SyncASGIClient = TestClient

@asynccontextmanager
async def _noop_lifespan(_app: FastAPI):
    yield


@pytest.fixture(autouse=True)
def disable_app_lifespan():
    original_lifespan = app.router.lifespan_context
    app.router.lifespan_context = _noop_lifespan
    yield
    app.router.lifespan_context = original_lifespan


def _get_live_auth_middleware_module():
    """Find the auth middleware namespace the running app actually uses.

    ``test_auth_fail_closed`` reloads ``apo.auth.middleware`` mid-session,
    replacing the entry in ``sys.modules`` with a new module object. The app's
    middleware class, however, still executes methods in the ORIGINAL module's
    namespace (where they were defined). We reach that namespace through a
    method's ``__globals__``, not through ``sys.modules``.
    """
    from apo.api import app

    for mw in app.user_middleware:
        cls = mw.cls
        # Methods carry __globals__ pointing at their defining module's dict.
        for attr in vars(cls).values():
            if hasattr(attr, "__globals__") and "AUTH_SECRET" in attr.__globals__:
                return attr.__globals__
    from apo.auth import middleware as fallback
    return fallback


@pytest.fixture(autouse=True)
def open_dev_auth_bypass(request):
    """Force the auth middleware into open-dev mode for all tests.

    SPEC-132 made the middleware fail closed (401) when ``AUTH_SECRET`` is set,
    even in the development profile. That is correct for production but breaks
    every test that uses the plain ``client`` fixture (which sends no cookie or
    API key). Route tests exercise application logic, not auth — the dedicated
    auth tests use ``make_authed_client``. Patching the middleware module's
    ``AUTH_SECRET`` binding to empty enables the open-dev bypass so protected
    routes are reachable.

    Tests that exercise real API-key auth (e.g. OTLP end-to-end) mark
    themselves with ``@pytest.mark.real_auth`` to opt out; for those we restore
    the original secret so the middleware validates credentials normally.
    """
    auth_ns = _get_live_auth_middleware_module()

    def _get_secret() -> str:
        return auth_ns["AUTH_SECRET"] if isinstance(auth_ns, dict) else auth_ns.AUTH_SECRET

    def _set_secret(value: str) -> None:
        if isinstance(auth_ns, dict):
            auth_ns["AUTH_SECRET"] = value
        else:
            auth_ns.AUTH_SECRET = value

    if request.node.get_closest_marker("real_auth"):
        original = _get_secret()
        _set_secret(_get_secret() or "dev-secret-change-me")
        yield
        _set_secret(original)
        return

    original = _get_secret()
    _set_secret("")
    yield
    _set_secret(original)


@pytest.fixture(autouse=True)
def reset_rate_limiters():
    """Clear module-level rate limiter state between tests."""
    from apo.auth.rate_limit import login_rate_limiter

    login_rate_limiter._attempts.clear()
    try:
        from apo.routes.auth import resend_rate_limiter

        resend_rate_limiter._attempts.clear()
    except ImportError:
        pass
    yield
    login_rate_limiter._attempts.clear()
    try:
        from apo.routes.auth import resend_rate_limiter

        resend_rate_limiter._attempts.clear()
    except ImportError:
        pass


@pytest.fixture
def db_schema():
    SQLModel.metadata.create_all(engine)
    yield
    SQLModel.metadata.drop_all(engine)


@pytest.fixture(name="session")
def session_fixture(db_schema: None):
    with Session(engine) as session:
        yield session


@pytest.fixture(name="client")
def client_fixture(db_schema: None):
    def get_session_override():
        with Session(engine) as request_session:
            yield request_session

    app.dependency_overrides[get_session] = get_session_override
    client = TestClient(app)
    try:
        yield client
    finally:
        client.close()
        app.dependency_overrides.clear()


@pytest.fixture(name="make_authed_client")
def make_authed_client_fixture():
    """Factory fixture that creates authenticated TestClients.

    Each call returns a TestClient with a middleware that injects the given
    ``user_id`` (and optionally ``is_admin``) into ``request.state``, bypassing
    the real AuthMiddleware which is in open-dev mode during tests.

    Usage::

        authed = make_authed_client(user_id, session)
        resp = authed.get("/v1/api-keys")
    """

    def _create(user_id: str, session: Session, is_admin: bool = True) -> TestClient:
        class InjectAuthMiddleware(BaseHTTPMiddleware):
            async def dispatch(
                self,
                request: Request,
                call_next: Callable[[Request], Awaitable[Response]],
            ) -> Response:
                request.state.user_id = user_id
                request.state.is_admin = is_admin
                return await call_next(request)

        new_app = FastAPI()
        new_app.include_router(app.router)
        new_app.add_middleware(InjectAuthMiddleware)

        def _session_override() -> Session:
            return session

        new_app.dependency_overrides[get_session] = _session_override
        return TestClient(new_app)

    return _create


def pytest_pyfunc_call(pyfuncitem: Any) -> bool | None:
    test_function = pyfuncitem.obj
    if not inspect.iscoroutinefunction(test_function):
        return None

    funcargs = {
        arg_name: pyfuncitem.funcargs[arg_name]
        for arg_name in pyfuncitem._fixtureinfo.argnames
    }
    asyncio.run(test_function(**funcargs))
    return True


def pytest_configure(config: Any) -> None:
    config.addinivalue_line(
        "markers",
        "asyncio: run async test functions using the local asyncio compatibility hook",
    )
    config.addinivalue_line(
        "markers",
        "real_auth: opt out of the open-dev auth bypass — test supplies real API-key/service-token credentials",
    )
