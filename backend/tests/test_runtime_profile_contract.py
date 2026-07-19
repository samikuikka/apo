"""Tests for SPEC-132 deployment-profile runtime contract.

Establishes the v1 release contract fields on ``RuntimeConfig``:

- ``deployment_profile`` derived from ``APO_DEPLOYMENT_PROFILE``
- ``public_url`` derived from ``APO_PUBLIC_URL``
- ``supported_topology`` renamed to the v1 value ``"single-node"``
- ``max_concurrent_batches`` derived from
  ``AGENT_TASK_MAX_CONCURRENT_BATCHES`` (default 1, min 1, max 8)
- ``trusted_task_sources_only`` always ``True`` in v1

These fields are what operators and the operator CLI rely on to confirm
which topology an instance is actually running in.
"""

from __future__ import annotations

from typing import cast

from _pytest.monkeypatch import MonkeyPatch

from apo.services.runtime_config import (
    DEFAULT_MAX_CONCURRENT_BATCHES,
    MAX_CONCURRENT_BATCHES_LIMIT,
    get_runtime_config,
)


# ---------------------------------------------------------------------------
# Deployment profile
# ---------------------------------------------------------------------------


class TestDeploymentProfile:
    def test_defaults_to_development_when_unset(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.delenv("APO_DEPLOYMENT_PROFILE", raising=False)

        config = get_runtime_config()

        assert config.deployment_profile == "development"

    def test_local_profile_honored(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "local")

        config = get_runtime_config()

        assert config.deployment_profile == "local"

    def test_server_profile_honored(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "server")

        config = get_runtime_config()

        assert config.deployment_profile == "server"

    def test_invalid_profile_falls_back_to_development(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "staging")

        config = get_runtime_config()

        assert config.deployment_profile == "development"

    def test_profile_is_case_insensitive(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "LOCAL")

        config = get_runtime_config()

        assert config.deployment_profile == "local"


# ---------------------------------------------------------------------------
# Public URL
# ---------------------------------------------------------------------------


class TestPublicUrl:
    def test_public_url_from_env(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_PUBLIC_URL", "https://apo.example.com")

        config = get_runtime_config()

        assert config.public_url == "https://apo.example.com"

    def test_public_url_defaults_to_frontend_url(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """When APO_PUBLIC_URL is unset, the public URL falls back to the
        frontend URL so the contract always carries one origin."""
        monkeypatch.delenv("APO_PUBLIC_URL", raising=False)
        monkeypatch.setenv("FRONTEND_URL", "http://localhost:3000")

        config = get_runtime_config()

        assert config.public_url == "http://localhost:3000"


# ---------------------------------------------------------------------------
# Supported topology (renamed for v1)
# ---------------------------------------------------------------------------


class TestSupportedTopology:
    def test_topology_is_v1_single_node(self) -> None:
        config = get_runtime_config()

        assert config.supported_topology == "single-node"


# ---------------------------------------------------------------------------
# Max concurrent batches
# ---------------------------------------------------------------------------


class TestMaxConcurrentBatches:
    def test_defaults_to_one(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.delenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", raising=False)

        config = get_runtime_config()

        assert config.max_concurrent_batches == 1

    def test_custom_value_within_range(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", "4")

        config = get_runtime_config()

        assert config.max_concurrent_batches == 4

    def test_clamped_to_minimum(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", "0")

        config = get_runtime_config()

        assert config.max_concurrent_batches == 1

    def test_clamped_to_maximum(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", "99")

        config = get_runtime_config()

        assert config.max_concurrent_batches == MAX_CONCURRENT_BATCHES_LIMIT

    def test_invalid_value_falls_back_to_default(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        monkeypatch.setenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", "not-a-number")

        config = get_runtime_config()

        assert config.max_concurrent_batches == DEFAULT_MAX_CONCURRENT_BATCHES

    def test_negative_value_clamped_to_minimum(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", "-3")

        config = get_runtime_config()

        assert config.max_concurrent_batches == 1


# ---------------------------------------------------------------------------
# Trusted task sources
# ---------------------------------------------------------------------------


class TestTrustedTaskSourcesOnly:
    def test_always_true_in_v1(self) -> None:
        config = get_runtime_config()

        assert config.trusted_task_sources_only is True


# ---------------------------------------------------------------------------
# Serialization safety: no secrets leak through new fields
# ---------------------------------------------------------------------------


class TestRuntimeConfigSerialization:
    def test_serialized_form_contains_new_fields(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_DEPLOYMENT_PROFILE", "server")
        monkeypatch.setenv("APO_PUBLIC_URL", "https://apo.example.com")
        monkeypatch.setenv("AGENT_TASK_MAX_CONCURRENT_BATCHES", "2")

        body = cast(dict, get_runtime_config().model_dump())

        assert body["deployment_profile"] == "server"
        assert body["public_url"] == "https://apo.example.com"
        assert body["supported_topology"] == "single-node"
        assert body["max_concurrent_batches"] == 2
        assert body["trusted_task_sources_only"] is True
