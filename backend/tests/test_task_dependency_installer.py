"""Tests for SPEC-125 hardening: task dependency install policy."""

from pathlib import Path
from types import ModuleType
from typing import cast

from _pytest.monkeypatch import MonkeyPatch

from apo.services.task_dependency_installer import (
    DEFAULT_INSTALL_TIMEOUT_SECONDS,
    TaskDependencyInstallError,
    _detect_install_plans,
    install_task_dependencies,
)


def _reload_installer() -> ModuleType:
    import importlib
    import sys

    _ = sys.modules.pop("apo.services.task_dependency_installer", None)
    import apo.services.task_dependency_installer as module

    return importlib.reload(module)


class TestInstallPlanDetection:
    def test_pnpm_lockfile_yields_frozen_pnpm_install(self, tmp_path: Path) -> None:
        _ = (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: '6.0'\n")
        _ = (tmp_path / "package.json").write_text("{}\n")

        plans = _detect_install_plans(tmp_path)

        assert len(plans) == 1
        assert plans[0].ecosystem == "node"
        assert plans[0].command[0] == "pnpm"
        assert "--frozen-lockfile" in plans[0].command

    def test_npm_lockfile_uses_ci_for_reproducibility(
        self, tmp_path: Path
    ) -> None:
        _ = (tmp_path / "package-lock.json").write_text('{"lockfileVersion": 3}\n')
        _ = (tmp_path / "package.json").write_text("{}\n")

        plans = _detect_install_plans(tmp_path)

        assert len(plans) == 1
        assert plans[0].command[0] == "npm"
        assert "ci" in plans[0].command
        assert "--no-audit" in plans[0].command

    def test_yarn_lockfile_uses_immutable_install(self, tmp_path: Path) -> None:
        _ = (tmp_path / "yarn.lock").write_text("# yarn lockfile\n")
        _ = (tmp_path / "package.json").write_text("{}\n")

        plans = _detect_install_plans(tmp_path)

        assert len(plans) == 1
        assert plans[0].command[0] == "yarn"
        assert "--immutable" in plans[0].command

    def test_uv_lockfile_uses_frozen_sync(self, tmp_path: Path) -> None:
        _ = (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
        _ = (tmp_path / "uv.lock").write_text("version='1'\n")

        plans = _detect_install_plans(tmp_path)

        assert len(plans) == 1
        assert plans[0].ecosystem == "python"
        assert plans[0].command[:2] == ["uv", "sync"]
        assert "--frozen" in plans[0].command

    def test_requirements_txt_uses_pip_install_r(
        self, tmp_path: Path
    ) -> None:
        _ = (tmp_path / "requirements.txt").write_text("requests==2.31.0\n")

        plans = _detect_install_plans(tmp_path)

        assert len(plans) == 1
        assert plans[0].command[0] == "pip"
        assert "-r" in plans[0].command
        assert "requirements.txt" in plans[0].command

    def test_no_lockfile_means_no_plan(self, tmp_path: Path) -> None:
        plans = _detect_install_plans(tmp_path)
        assert plans == []

    def test_node_plan_precedes_python_plan(self, tmp_path: Path) -> None:
        _ = (tmp_path / "package-lock.json").write_text("{}\n")
        _ = (tmp_path / "package.json").write_text("{}\n")
        _ = (tmp_path / "requirements.txt").write_text("requests\n")

        plans = _detect_install_plans(tmp_path)

        assert [p.ecosystem for p in plans] == ["node", "python"]


class TestInstallCacheBehavior:
    def test_first_install_runs_command(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        cache_root = tmp_path / "cache"
        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        _ = (workspace / "package-lock.json").write_text('{"lockfileVersion": 1}\n')
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setenv("TASK_INSTALL_CACHE_DIR", str(cache_root))
        # Pretend npm is available + always succeeds.
        monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")

        captured: list[list[str]] = []

        class _FakeCompleted:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(cmd, *args, **kwargs):  # type: ignore[no-untyped-def]
            captured.append(list(cmd))
            return _FakeCompleted()

        monkeypatch.setattr("subprocess.run", fake_run)

        install_task_dependencies(workspace)

        assert len(captured) == 1
        assert captured[0][0] == "npm"
        # Marker file exists so the next run is a cache hit.
        markers = list(cache_root.rglob(".installed"))
        assert len(markers) == 1

    def test_second_install_with_same_lockfile_is_a_cache_hit(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        cache_root = tmp_path / "cache"
        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        _ = (workspace / "package-lock.json").write_text('{"lockfileVersion": 1}\n')
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setenv("TASK_INSTALL_CACHE_DIR", str(cache_root))
        monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")

        run_count = 0

        class _FakeCompleted:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
            nonlocal run_count
            run_count += 1
            return _FakeCompleted()

        monkeypatch.setattr("subprocess.run", fake_run)

        install_task_dependencies(workspace)
        install_task_dependencies(workspace)  # cache hit

        assert run_count == 1, "second call must skip install"

    def test_lockfile_change_invalidates_cache(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        cache_root = tmp_path / "cache"
        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        lockfile = workspace / "package-lock.json"
        _ = lockfile.write_text('{"lockfileVersion": 1}\n')
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setenv("TASK_INSTALL_CACHE_DIR", str(cache_root))
        monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")

        run_count = 0

        class _FakeCompleted:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
            nonlocal run_count
            run_count += 1
            return _FakeCompleted()

        monkeypatch.setattr("subprocess.run", fake_run)

        install_task_dependencies(workspace)
        # Mutate the lockfile → next install must run again.
        _ = lockfile.write_text('{"lockfileVersion": 2}\n')
        install_task_dependencies(workspace)

        assert run_count == 2, "lockfile change must invalidate cache"


class TestInstallFailureModes:
    def test_missing_package_manager_raises_operator_error(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        _ = (workspace / "package-lock.json").write_text("{}\n")
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setattr("shutil.which", lambda _: None)

        try:
            install_task_dependencies(workspace)
        except TaskDependencyInstallError as error:
            assert "not installed" in str(error)
            assert "npm" in str(error)
        else:
            raise AssertionError("expected TaskDependencyInstallError")

    def test_nonzero_exit_raises_operator_error_with_excerpt(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        _ = (workspace / "package-lock.json").write_text("{}\n")
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")

        class _FakeCompleted:
            returncode = 1
            stdout = ""
            stderr = "ERESOLVE unable to resolve dependency tree"

        monkeypatch.setattr("subprocess.run", lambda *a, **k: _FakeCompleted())

        try:
            install_task_dependencies(workspace)
        except TaskDependencyInstallError as error:
            message = str(error)
            assert "failed" in message.lower()
            assert "npm" in message
            assert "ERESOLVE" in message
        else:
            raise AssertionError("expected TaskDependencyInstallError")

    def test_timeout_raises_operator_error(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        import subprocess

        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        _ = (workspace / "package-lock.json").write_text("{}\n")
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setattr("shutil.which", lambda name: f"/usr/bin/{name}")

        def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
            raise subprocess.TimeoutExpired(cmd=args[0], timeout=1)

        monkeypatch.setattr("subprocess.run", fake_run)

        try:
            install_task_dependencies(workspace)
        except TaskDependencyInstallError as error:
            assert "timed out" in str(error)
        else:
            raise AssertionError("expected TaskDependencyInstallError")


class TestInstallPolicyToggles:
    def test_disabling_install_via_env_skips_entirely(
        self,
        tmp_path: Path,
        monkeypatch: MonkeyPatch,
    ) -> None:
        workspace = tmp_path / "workspace"
        _ = workspace.mkdir()
        _ = (workspace / "package-lock.json").write_text("{}\n")
        _ = (workspace / "package.json").write_text("{}\n")

        monkeypatch.setenv("TASK_INSTALL_DISABLE", "true")
        run_count = 0

        def fake_run(*args, **kwargs):  # type: ignore[no-untyped-def]
            nonlocal run_count
            run_count += 1
            raise AssertionError("install must not run when disabled")

        monkeypatch.setattr("subprocess.run", fake_run)

        install_task_dependencies(workspace)
        assert run_count == 0

    def test_timeout_override_is_respected(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TASK_INSTALL_TIMEOUT_SECONDS", "999")
        module = _reload_installer()
        assert cast(ModuleType, module)._install_timeout_seconds() == 999

    def test_timeout_override_clamped_to_minimum_30s(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TASK_INSTALL_TIMEOUT_SECONDS", "5")
        module = _reload_installer()
        assert cast(ModuleType, module)._install_timeout_seconds() == 30

    def test_invalid_timeout_falls_back_to_default(
        self, tmp_path: Path, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("TASK_INSTALL_TIMEOUT_SECONDS", "garbage")
        module = _reload_installer()
        assert (
            cast(ModuleType, module)._install_timeout_seconds()
            == DEFAULT_INSTALL_TIMEOUT_SECONDS
        )
