"""Tests for SPEC-125 containerized agent-task runtime packaging."""

from pathlib import Path
from types import ModuleType
from typing import cast

from _pytest.monkeypatch import MonkeyPatch


def _reload_runtime() -> ModuleType:
    import importlib
    import sys

    for module_name in (
        "apo.services.agent_task_runtime",
        "apo.services.runtime_config",
    ):
        _ = sys.modules.pop(module_name, None)
    import apo.services.agent_task_runtime as module

    return importlib.reload(module)


class TestResolveTaskRuntime:
    def test_packaged_runtime_is_preferred_when_present(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        runner = runtime_dir / "runner.mjs"
        _ = runner.write_text("// stub\n")

        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))

        module = _reload_runtime()
        resolved = cast(ModuleType, module).resolve_task_runtime()

        assert resolved.available is True
        assert resolved.runner_path == str(runner)
        assert resolved.runner_argv[-1] == str(runner)
        node_bin = resolved.runner_argv[0]
        assert node_bin.endswith("node")

    def test_dev_tsx_fallback_when_packaged_runtime_missing(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))

        module = _reload_runtime()
        tsx_bin = tmp_path / "tsx"
        runner_entry = tmp_path / "runner-entry.ts"
        _ = tsx_bin.write_text("#!/usr/bin/env node\n")
        _ = runner_entry.write_text("// stub\n")
        monkeypatch.setattr(module, "DEV_TSX_BIN", tsx_bin)
        monkeypatch.setattr(module, "DEV_RUNNER_ENTRY", runner_entry)

        resolved = cast(ModuleType, module).resolve_task_runtime()

        # Dev mode: tsx + runner-entry.ts fallback.
        assert resolved.available is True
        assert resolved.runner_path is not None
        assert resolved.runner_path.endswith("runner-entry.ts")

    def test_unavailable_when_node_missing(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))

        module = _reload_runtime()
        # Force unavailable AFTER reload so patches stick.
        monkeypatch.setattr("shutil.which", lambda _: None)
        monkeypatch.setattr(module, "DEV_TSX_BIN", Path("/nonexistent/tsx"))
        monkeypatch.setattr(
            module, "DEV_RUNNER_ENTRY", Path("/nonexistent/runner-entry.ts")
        )

        resolved = cast(ModuleType, module).resolve_task_runtime()

        assert resolved.available is False
        assert resolved.error is not None
        assert "not installed" in resolved.error


class TestTaskRuntimeStatus:
    def test_status_payload_shape(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        runner = runtime_dir / "runner.mjs"
        _ = runner.write_text("// stub\n")
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))

        module = _reload_runtime()
        status = cast(ModuleType, module).get_task_runtime_status()

        assert status.available is True
        assert status.runner_path == str(runner)
        # Node version is detected from the actual node binary on the test host.
        assert status.node_version is None or status.node_version.startswith("v")
        assert status.error is None

    def test_probe_readiness_check_returns_runner_path(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        runner = runtime_dir / "runner.mjs"
        _ = runner.write_text("// stub\n")
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))

        module = _reload_runtime()
        result = cast(ModuleType, module).probe_task_runtime()

        assert result.ok is True
        assert result.name == "task_runtime"
        assert result.detail == str(runner)


class TestTaskRuntimeEndpoint:
    def test_task_runtime_endpoint_requires_admin(self, client) -> None:  # type: ignore[no-untyped-def]
        response = client.get("/v1/system/task-runtime")
        assert response.status_code == 401

    def test_task_runtime_endpoint_returns_payload_for_admin(
        self,
        client,  # type: ignore[no-untyped-def]
        session,  # type: ignore[no-untyped-def]
        make_authed_client,  # type: ignore[no-untyped-def]
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        runner = runtime_dir / "runner.mjs"
        _ = runner.write_text("// stub\n")
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))
        module = _reload_runtime()
        # Patch the route's imported symbol too — FastAPI imported the old ref.
        from apo.routes import system_runtime

        monkeypatch.setattr(
            system_runtime,
            "get_task_runtime_status",
            module.get_task_runtime_status,
        )

        from sqlmodel import select

        from apo.models.db import UserDB

        resp = client.post(
            "/auth/setup",
            json={"email": "admin@test.com", "password": "AdminPass123", "name": "Admin"},
        )
        assert resp.status_code == 200, resp.text
        admin_user = session.exec(select(UserDB)).first()
        assert admin_user is not None
        admin_user.is_admin = True
        session.add(admin_user)
        session.commit()
        session.refresh(admin_user)

        authed = make_authed_client(admin_user.id, session, is_admin=True)
        response = authed.get("/v1/system/task-runtime")

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["available"] is True
        assert body["runner_path"] == str(runner)
        assert "node_version" in body
        assert body["error"] is None


class TestRunnerUsesPackagedRuntime:
    """SPEC-125: the runner must call the resolved argv, not the old inline script."""

    def test_run_task_subprocess_invokes_resolved_argv(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        runner = runtime_dir / "runner.mjs"
        _ = runner.write_text("// stub\n")
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))
        module = _reload_runtime()
        from apo.routes import system_runtime as route_module
        from apo.services import agent_task_runner as runner_module

        monkeypatch.setattr(
            runner_module,
            "resolve_task_runtime",
            module.resolve_task_runtime,
            raising=False,
        )
        # No-op safety: route also imports the symbol.
        _ = route_module

        captured_argv: list[list[str]] = []
        captured_kwargs: dict[str, object] = {}

        class _FakeCompleted:
            returncode = 0
            stdout = '{"pass": true}'
            stderr = ""

        def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
            captured_argv.append(list(args[0]))
            captured_kwargs.update(kwargs)
            return _FakeCompleted()

        monkeypatch.setattr("subprocess.run", fake_run)

        result = runner_module._run_task_subprocess(
            task_run_id="run-1",
            task_dir=str(tmp_path),
            project="proj",
            environment="default",
            run_metadata=None,
        )

        assert result == {"pass": True}
        assert len(captured_argv) == 1
        assert captured_argv[0][-1].endswith("runner.mjs")
        assert "cwd" in captured_kwargs

    def test_run_task_subprocess_raises_operator_error_when_unavailable(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        runtime_dir = tmp_path / "agent-task-runtime"
        _ = runtime_dir.mkdir()
        monkeypatch.setenv("AGENT_TASK_RUNTIME_DIR", str(runtime_dir))
        module = _reload_runtime()
        monkeypatch.setattr("shutil.which", lambda _: None)
        monkeypatch.setattr(module, "DEV_TSX_BIN", Path("/nonexistent/tsx"))
        monkeypatch.setattr(
            module, "DEV_RUNNER_ENTRY", Path("/nonexistent/runner-entry.ts")
        )
        from apo.services import agent_task_runner as runner_module

        monkeypatch.setattr(
            runner_module,
            "resolve_task_runtime",
            module.resolve_task_runtime,
            raising=False,
        )

        try:
            runner_module._run_task_subprocess(
                task_run_id="run-1",
                task_dir=str(tmp_path),
                project="proj",
                environment="default",
                run_metadata=None,
            )
        except RuntimeError as error:
            assert "not installed" in str(error)
        else:
            raise AssertionError("expected RuntimeError when runtime unavailable")
