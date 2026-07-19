"""Tests for task subprocess environment allow-listing (SPEC-132, Behavior 6).

Task code runs as an untrusted subprocess. Previously it inherited the
full backend environment via ``os.environ.copy()``, leaking platform
secrets (``AUTH_SECRET``, ``DATABASE_URL``, OAuth, SMTP, ...) to every
task. These tests pin the new explicit-allow-list contract:

- Platform deny-listed secrets are NEVER present, regardless of config.
- The task-contract vars (``AGENT_TASK_*``, ``APO_AUTH_TOKEN``, provider
  keys) ARE present.
- A safe minimal set of process essentials (PATH, HOME, etc.) is present
  so Node/Python can run.
- Extra vars are included only when named in ``APO_TASK_ENV_ALLOWLIST``.
"""

from __future__ import annotations

from typing import cast

from _pytest.monkeypatch import MonkeyPatch

from apo.services.agent_task_runner import _build_task_subprocess_env


# The complete platform-secret deny-list from SPEC-132 Behavior 6.
DENY_LISTED = (
    "AUTH_SECRET",
    "DATABASE_URL",
    "POSTGRES_PASSWORD",
    "ADMIN_API_KEY",
    "API_KEY_SALT",
    "EMAIL_TRANSPORT_URL",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_TOKEN_ENCRYPTION_KEY",
)


def _build_env(
    monkeypatch: MonkeyPatch,
    *,
    task_run_id: str = "run-123",
    task_dir: str = "/tmp/task",
    project: str = "proj",
    environment: str = "env",
    run_metadata: dict[str, object] | None = None,
) -> dict[str, str]:
    """Call the real builder with the current process env as the backdrop."""
    return _build_task_subprocess_env(
        task_run_id=task_run_id,
        task_dir=task_dir,
        project=project,
        environment=environment,
        run_metadata=run_metadata,
    )


class TestDenyListedSecretsAreExcluded:
    """No platform secret may reach task code, no matter how it is set."""

    def test_deny_listed_secrets_absent_when_set_on_process(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        for name in DENY_LISTED:
            monkeypatch.setenv(name, f"leak-{name.lower()}-value")

        env = _build_env(monkeypatch)

        for name in DENY_LISTED:
            assert name not in env, f"{name} leaked into task subprocess env"
            # Also check no value carries the secret by content.
            for key, value in env.items():
                assert f"leak-{name.lower()}-value" not in value, (
                    f"secret from {name} surfaced via {key}"
                )

    def test_deny_listed_secrets_absent_even_if_in_allowlist(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """An operator listing a deny-listed var in the allow-list must NOT
        override the deny-list — that would be a trivial security bypass."""
        for name in DENY_LISTED:
            monkeypatch.setenv(name, f"secret-{name}")
        monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", ",".join(DENY_LISTED))

        env = _build_env(monkeypatch)

        for name in DENY_LISTED:
            assert name not in env


class TestTaskContractVarsPresent:
    """The variables the task runtime (runner-entry.ts) reads must be set."""

    def test_agent_task_contract_vars_present(self, monkeypatch: MonkeyPatch) -> None:
        env = _build_env(
            monkeypatch,
            task_run_id="run-abc",
            task_dir="/work/task",
            project="proj-1",
            environment="staging",
        )

        assert env["AGENT_TASK_DIR"] == "/work/task"
        assert env["AGENT_TASK_PROJECT"] == "proj-1"
        assert env["AGENT_TASK_ENVIRONMENT"] == "staging"
        assert env["AGENT_TASK_RUN_ID"] == "run-abc"
        assert env["AGENT_TASK_TRACE_REQUIRED"] == "true"
        assert env["AGENT_TASK_TRACE_ENDPOINT"]  # non-empty default
        assert env["APO_AUTH_TOKEN"]  # short-lived token generated

    def test_run_metadata_is_json_serialized(self, monkeypatch: MonkeyPatch) -> None:
        import json

        env = _build_env(
            monkeypatch,
            task_run_id="r1",
            run_metadata={"foo": "bar", "n": 2},
        )

        parsed = cast(dict[str, object], json.loads(env["AGENT_TASK_RUN_METADATA"]))
        assert parsed["agent_task_run_id"] == "r1"
        assert parsed["foo"] == "bar"
        assert parsed["n"] == 2

    def test_run_metadata_none_yields_run_id_only(self, monkeypatch: MonkeyPatch) -> None:
        import json

        env = _build_env(monkeypatch, task_run_id="r2", run_metadata=None)

        parsed = cast(dict[str, object], json.loads(env["AGENT_TASK_RUN_METADATA"]))
        assert parsed == {"agent_task_run_id": "r2"}


class TestProviderVarsPresent:
    """The packaged runtime needs the operator's provider credentials."""

    def test_openrouter_api_key_passed_through_when_set(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-xyz")

        env = _build_env(monkeypatch)

        assert env.get("OPENROUTER_API_KEY") == "sk-or-xyz"

    def test_openrouter_base_url_and_model_passed_through(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENROUTER_BASE_URL", "https://custom.example/api")
        monkeypatch.setenv("AGENT_TASK_OPENROUTER_MODEL", "vendor/model-x")

        env = _build_env(monkeypatch)

        assert env["OPENROUTER_BASE_URL"] == "https://custom.example/api"
        assert env["OPENROUTER_MODEL"] == "vendor/model-x"

    def test_provider_defaults_when_unset(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
        monkeypatch.delenv("AGENT_TASK_OPENROUTER_MODEL", raising=False)

        env = _build_env(monkeypatch)

        assert env["OPENROUTER_BASE_URL"] == "https://openrouter.ai/api/v1"
        assert env["OPENROUTER_MODEL"] == "google/gemini-2.5-flash-lite"


class TestProcessEssentials:
    """A minimal process environment so Node/Python can run and create
    temp files. These must be inherited from the backend process."""

    ESSENTIALS = ("PATH", "HOME", "LANG")

    def test_essentials_inherited(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("PATH", "/usr/bin:/usr/local/bin")
        monkeypatch.setenv("HOME", "/home/apo")
        monkeypatch.setenv("LANG", "en_US.UTF-8")

        env = _build_env(monkeypatch)

        for name in self.ESSENTIALS:
            assert name in env, f"{name} missing — subprocess won't run"

    def test_arbitrary_non_essential_var_is_excluded_by_default(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """A random env var not in the contract must NOT be inherited."""
        monkeypatch.setenv("UNRELATED_PLATFORM_VAR", "should-not-leak")

        env = _build_env(monkeypatch)

        assert "UNRELATED_PLATFORM_VAR" not in env


class TestTaskEnvAllowlist:
    """Operators may grant additional vars to task code via an explicit
    allow-list."""

    def test_allowlisted_var_is_included(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("MY_TASK_CONFIG", "special")
        monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", "MY_TASK_CONFIG")

        env = _build_env(monkeypatch)

        assert env.get("MY_TASK_CONFIG") == "special"

    def test_multiple_allowlisted_vars(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("FOO", "1")
        monkeypatch.setenv("BAR", "2")
        monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", "FOO,BAR")

        env = _build_env(monkeypatch)

        assert env.get("FOO") == "1"
        assert env.get("BAR") == "2"

    def test_allowlist_whitespace_tolerated(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("FOO", "1")
        monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", " FOO ,  BAR ")

        env = _build_env(monkeypatch)

        assert env.get("FOO") == "1"

    def test_allowlisted_var_not_set_is_absent(self, monkeypatch: MonkeyPatch) -> None:
        """Allow-listing a name that isn't in the process env must not create
        an empty entry — task code checks presence, and an empty string is a
        truthy-env entry that would confuse it."""
        monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", "NEVER_SET_VAR")

        env = _build_env(monkeypatch)

        assert "NEVER_SET_VAR" not in env

    def test_allowlist_itself_not_passed_to_task(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_TASK_ENV_ALLOWLIST", "FOO")

        env = _build_env(monkeypatch)

        assert "APO_TASK_ENV_ALLOWLIST" not in env
