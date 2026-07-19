"""Tests for git credential redaction in task source sync (SPEC-132, Behavior 6).

Git clone URLs may carry embedded credentials — either operator-supplied
(`https://user:password@host/...`) or injected by
`_maybe_inject_github_token` (`https://x-access-token:<token>@github.com/...`).
When git fails, it echoes the attempted URL into stderr. These tests
assert that ``_run_git`` never lets those credentials reach
``GitError`` messages, which flow into ``source.last_error`` and the UI.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from apo.services.project_task_source_sync import GitError, _run_git


# ---------------------------------------------------------------------------
# _redact_git_credentials (unit-level, no subprocess)
# ---------------------------------------------------------------------------


def _redact(text: str) -> str:
    """Import lazily so the test fails clearly if the helper is missing."""
    from apo.services.project_task_source_sync import _redact_git_credentials

    return _redact_git_credentials(text)


class TestRedactGitCredentials:
    def test_redacts_userinfo_from_https_url(self) -> None:
        text = "fatal: unable to access 'https://x-access-token:ghp_SECRET123@github.com/org/repo.git/': Could not resolve host"
        redacted = _redact(text)

        assert "ghp_SECRET123" not in redacted
        assert "x-access-token:ghp_SECRET123@" not in redacted
        assert "github.com/org/repo.git" in redacted  # rest preserved

    def test_redacts_user_password_pair(self) -> None:
        text = "fatal: 'https://alice:hunter2@github.com/org/repo.git' not found"
        redacted = _redact(text)

        assert "hunter2" not in redacted
        assert "alice:hunter2@" not in redacted

    def test_redacts_multiple_urls_in_one_message(self) -> None:
        text = (
            "failed to clone https://token:abc123@github.com/a.git "
            "and https://user:pass@gitlab.com/b.git"
        )
        redacted = _redact(text)

        assert "abc123" not in redacted
        assert "pass" not in redacted

    def test_leaves_anonymous_url_untouched(self) -> None:
        text = "fatal: could not read from https://github.com/org/repo.git"
        assert _redact(text) == text

    def test_leaves_plain_text_without_url_untouched(self) -> None:
        text = "git checkout failed with exit code 1: some plain error"
        assert _redact(text) == text

    def test_redacts_ssh_style_is_not_applicable(self) -> None:
        # SSH URLs (git@github.com:org/repo.git) carry no password in the URL
        # itself; we only redact URL user-info, so this must pass through.
        text = "git@github.com:org/repo.git"
        assert _redact(text) == text


# ---------------------------------------------------------------------------
# _run_git integration — the real safety property
# ---------------------------------------------------------------------------


def _make_called_process_error(stderr: str) -> subprocess.CalledProcessError:
    """Construct a CalledProcessError like subprocess.run(check=True) raises."""
    return subprocess.CalledProcessError(
        returncode=128, cmd=["git", "clone", "irrelevant"], stderr=stderr
    )


class TestRunGitRedactsOnFailure:
    def test_git_error_message_excludes_credentialed_url(self, tmp_path: Path) -> None:
        token = "ghp_TOPSECRET_token_value_456"
        credentialed_url = f"https://x-access-token:{token}@github.com/org/repo.git"
        git_stderr = (
            f"fatal: unable to access '{credentialed_url}/': "
            "Could not resolve host: github.com"
        )

        with patch("apo.services.project_task_source_sync.subprocess.run") as mock_run:
            mock_run.side_effect = _make_called_process_error(git_stderr)
            with pytest.raises(GitError) as exc_info:
                _run_git(tmp_path, "clone", credentialed_url)

        message = str(exc_info.value)
        assert token not in message
        assert "x-access-token:" not in message
        assert "github.com/org/repo.git" in message  # non-secret context preserved

    def test_git_error_message_excludes_user_password(self, tmp_path: Path) -> None:
        git_stderr = (
            "fatal: Authentication failed for "
            "'https://alice:hunter2@private-git.example.com/repo.git'"
        )

        with patch("apo.services.project_task_source_sync.subprocess.run") as mock_run:
            mock_run.side_effect = _make_called_process_error(git_stderr)
            with pytest.raises(GitError) as exc_info:
                _run_git(tmp_path, "fetch", "origin")

        message = str(exc_info.value)
        assert "hunter2" not in message
        assert "alice:hunter2@" not in message
        assert "private-git.example.com/repo.git" in message

    def test_args_listed_in_error_excludes_credentials(self, tmp_path: Path) -> None:
        """The error message echoes ``git <args>``; a credentialed URL passed
        as an argument must not leak there either."""
        credentialed_url = "https://token:leakme@github.com/org/repo.git"

        with patch("apo.services.project_task_source_sync.subprocess.run") as mock_run:
            mock_run.side_effect = _make_called_process_error("some stderr")
            with pytest.raises(GitError) as exc_info:
                _run_git(tmp_path, "clone", credentialed_url)

        message = str(exc_info.value)
        assert "leakme" not in message
        assert "token:leakme@" not in message

    def test_non_credentialed_failure_still_reports_cleanly(
        self, tmp_path: Path
    ) -> None:
        git_stderr = "error: pathspec 'feature-branch' did not match any file"

        with patch("apo.services.project_task_source_sync.subprocess.run") as mock_run:
            mock_run.side_effect = _make_called_process_error(git_stderr)
            with pytest.raises(GitError) as exc_info:
                _run_git(tmp_path, "checkout", "feature-branch")

        # Non-secret errors pass through unchanged so operators can debug.
        assert "pathspec 'feature-branch'" in str(exc_info.value)
