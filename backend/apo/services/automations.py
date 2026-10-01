"""Automations service: event conditions, typed actions, delivery, recovery.

Automations are project-scoped rules that watch run events (the same events
webhooks see), match them against declarative conditions, and deliver a
typed action — a signed webhook POST or a GitHub issue. The execution log
(``AutomationExecutionDB``) records every firing with its input, output, and
error; deliveries are at-most-once across restarts (orphaned pending rows
are marked error at startup, never retried — a duplicate GitHub issue is
worse than a missed notification).
"""

# pyright: reportAny=false, reportArgumentType=false, reportImplicitStringConcatenation=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import cast

import httpx
from cryptography.fernet import Fernet
from sqlalchemy import delete as sa_delete
from sqlmodel import Session, col, select

from ..db import engine
from ..db_helpers import as_column
from ..models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AutomationDB,
    AutomationExecutionDB,
)
from .run_event_types import ALL_EVENT_TYPES
from .webhook_delivery import (
    DELIVERY_TIMEOUT_SECONDS,
    MAX_CONSECUTIVE_FAILURES,
    MAX_RETRIES,
    next_delivery_health,
    sign_payload,
)
from .webhook_targets import (
    WebhookDestinationError,
    assert_public_destination,
    validate_webhook_url,
)

logger = logging.getLogger(__name__)

MAX_AUTOMATIONS_PER_PROJECT = 25
# Delivery-health policy (threshold, timeouts, retries) is shared with
# webhook deliveries so both surfaces fail and auto-disable identically;
# the alias keeps the automation-specific name used by tests and model docs.
AUTOMATION_MAX_CONSECUTIVE_FAILURES = MAX_CONSECUTIVE_FAILURES
DELIVERY_CONCURRENCY = 8
PRUNE_KEEP = 100
ERROR_MESSAGE_MAX_CHARS = 1000

ACTION_WEBHOOK = "webhook"
ACTION_GITHUB_ISSUE = "github_issue"
ACTION_SLACK = "slack"
ACTION_TYPES = (ACTION_WEBHOOK, ACTION_GITHUB_ISSUE, ACTION_SLACK)

_SLACK_URL_PREFIX = "https://hooks.slack.com/services/"
# Canonical incoming-webhook path: non-empty segments, no trailing slash —
# rejects the bare prefix and paths that would 404 every delivery.
_SLACK_URL_RE = re.compile(
    r"^https://hooks\.slack\.com/services/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)+$"
)

GITHUB_API_BASE = "https://api.github.com"
# GitHub login/repo name rules: alphanumerics, hyphens, underscores, dots;
# the all-dot and ``.git``-suffix exclusions are GitHub's own restrictions
# and also block path-segment normalization tricks.
_GITHUB_NAME_RE = re.compile(r"^[A-Za-z0-9-_.]+$")
_TEMPLATE_RE = re.compile(r"\{\{(\w+)\}\}")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


class AutomationRequestError(Exception):
    """Invalid automation configuration; ``status_code`` maps to the HTTP response."""

    message: str
    status_code: int

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class AutomationSecretsUnavailable(Exception):
    """The server lacks AUTOMATION_TOKEN_ENCRYPTION_KEY, so no token can be stored."""


class AutomationTokenError(Exception):
    """A stored GitHub token cannot be decrypted (key rotation); re-save it."""


# --- Condition vocabulary ---------------------------------------------------

TASK_RUN_EVENT_FIELDS = frozenset(
    {
        "task_run_id",
        "batch_run_id",
        "task_id",
        "status",
        "pass_result",
        "total_checks",
        "passed_checks",
        "failed_checks",
        "duration_ms",
        "total_cost",
        "trace_run_id",
        "started_at",
        "completed_at",
    }
)
BATCH_RUN_EVENT_FIELDS = frozenset(
    {
        "batch_run_id",
        "status",
        "total_tasks",
        "passed_tasks",
        "failed_tasks",
        "errored_tasks",
        "duration_ms",
        "started_at",
        "completed_at",
        "trigger.source",
        "schedule.name",
    }
)
TRACE_CLAIMED_EVENT_FIELDS = frozenset(
    {"task_run_id", "trace_run_id", "batch_run_id", "status"}
)

# Only batch-run payloads carry run_metadata; trigger/schedule conditions are
# therefore batch-event-only (enforced at create/update time).
EVENT_FIELDS: dict[str, frozenset[str]] = {
    "task_run.started": TASK_RUN_EVENT_FIELDS,
    "task_run.completed": TASK_RUN_EVENT_FIELDS,
    "task_run.error": TASK_RUN_EVENT_FIELDS,
    "batch_run.completed": BATCH_RUN_EVENT_FIELDS,
    "batch_run.failed": BATCH_RUN_EVENT_FIELDS,
    "task_run.trace_claimed": TRACE_CLAIMED_EVENT_FIELDS,
}

CONDITION_OPERATORS = frozenset({"eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"})

# Dotted fields resolve by walking run_metadata — the exact shape scheduled
# runs write (a trigger.schedule_name key does not exist anywhere).
_DOTTED_FIELD_RESOLVERS: dict[str, tuple[str, ...]] = {
    "trigger.source": ("run_metadata", "trigger", "source"),
    "schedule.name": ("run_metadata", "schedule", "name"),
}


def validate_event_type(event_type: str) -> None:
    if event_type not in ALL_EVENT_TYPES:
        raise AutomationRequestError(
            f"Unknown event type: {event_type!r}. "
            f"Valid: {', '.join(ALL_EVENT_TYPES)}"
        )


def validate_conditions(
    event_type: str, conditions: list[dict[str, object]]
) -> None:
    """Reject unknown fields/operators/values up front, naming the index."""
    allowlist = EVENT_FIELDS.get(event_type)
    if allowlist is None:
        raise AutomationRequestError(f"Unknown event type: {event_type!r}")
    for index, condition in enumerate(conditions):
        field = condition.get("field")
        operator = condition.get("operator")
        value = condition.get("value")
        if not isinstance(field, str) or field not in allowlist:
            raise AutomationRequestError(
                f"conditions[{index}]: unknown field {field!r} for event "
                f"{event_type!r}"
            )
        if not isinstance(operator, str) or operator not in CONDITION_OPERATORS:
            raise AutomationRequestError(
                f"conditions[{index}]: unknown operator {operator!r}. "
                f"Valid: {', '.join(sorted(CONDITION_OPERATORS))}"
            )
        if operator == "in":
            if not isinstance(value, list) or not value:
                raise AutomationRequestError(
                    f"conditions[{index}]: 'in' requires a non-empty list value"
                )
        elif operator == "contains":
            if not isinstance(value, str):
                raise AutomationRequestError(
                    f"conditions[{index}]: 'contains' requires a string value"
                )
        elif operator in ("gt", "gte", "lt", "lte"):
            if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                raise AutomationRequestError(
                    f"conditions[{index}]: {operator!r} requires a number or "
                    "string value"
                )


def _resolve_field(data: dict[str, object], field: str) -> tuple[bool, object]:
    """Return (present, value); a missing field counts as null."""
    path = _DOTTED_FIELD_RESOLVERS.get(field)
    if path is not None:
        current: object = data
        for segment in path:
            if not isinstance(current, dict) or segment not in current:
                return False, None
            current = current[segment]
        return True, current
    if field in data:
        return True, data[field]
    return False, None


def _json_type(value: object) -> str:
    # bool must be tested before number: Python's True == 1 would otherwise
    # let a boolean condition match a numeric payload.
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "other"


def _strict_eq(condition_value: object, payload_value: object) -> bool:
    condition_type = _json_type(condition_value)
    payload_type = _json_type(payload_value)
    if condition_type != payload_type:
        return False
    if condition_type not in ("null", "bool", "number", "string"):
        return False
    if condition_type == "null":
        return True
    return bool(condition_value == payload_value)


def conditions_match(
    conditions: list[dict[str, object]], data: dict[str, object]
) -> bool:
    """AND-combine conditions; fail closed on anything unrecognized."""
    for condition in conditions:
        field = condition.get("field")
        operator = condition.get("operator")
        value = condition.get("value")
        if not isinstance(field, str) or not isinstance(operator, str):
            logger.warning("Automation condition malformed: %r", condition)
            return False
        _, payload_value = _resolve_field(data, field)
        payload_type = _json_type(payload_value)
        if operator == "eq":
            matched = _strict_eq(value, payload_value)
        elif operator == "ne":
            matched = not _strict_eq(value, payload_value)
        elif operator in ("gt", "gte", "lt", "lte"):
            value_type = _json_type(value)
            if payload_type not in ("number", "string") or value_type != payload_type:
                matched = False
            elif payload_type == "number":
                left = cast("float", payload_value)
                right = cast("float", value)
                if operator == "gt":
                    matched = left > right
                elif operator == "gte":
                    matched = left >= right
                elif operator == "lt":
                    matched = left < right
                else:
                    matched = left <= right
            else:
                left = cast("str", payload_value)
                right = cast("str", value)
                if operator == "gt":
                    matched = left > right
                elif operator == "gte":
                    matched = left >= right
                elif operator == "lt":
                    matched = left < right
                else:
                    matched = left <= right
        elif operator == "in":
            if not isinstance(value, list):
                matched = False
            else:
                matched = any(_strict_eq(item, payload_value) for item in value)
        elif operator == "contains":
            matched = isinstance(payload_value, str) and isinstance(value, str) and (
                value in payload_value
            )
        else:
            logger.warning(
                "Automation condition operator %r unrecognized; not matching",
                operator,
            )
            return False
        if not matched:
            return False
    return True


# --- Action configuration ---------------------------------------------------


def validate_action_config(
    action_type: str, action_config: dict[str, object]
) -> dict[str, object]:
    """Validate and normalize per-type config; raises AutomationRequestError."""
    if action_type == ACTION_WEBHOOK:
        url = action_config.get("url")
        if not isinstance(url, str) or not url:
            raise AutomationRequestError(
                "action_config.url is required for webhook actions", 422
            )
        try:
            validate_webhook_url(url)
        except WebhookDestinationError as exc:
            raise AutomationRequestError(str(exc), 422) from exc
        return {"url": url}
    if action_type == ACTION_GITHUB_ISSUE:
        owner = action_config.get("owner")
        repo = action_config.get("repo")
        for label, value in (("owner", owner), ("repo", repo)):
            if not isinstance(value, str) or not _GITHUB_NAME_RE.match(value):
                raise AutomationRequestError(
                    f"action_config.{label} is invalid: {value!r}", 422
                )
            if set(value) == {"."} or value.endswith(".git"):
                raise AutomationRequestError(
                    f"action_config.{label} is invalid: {value!r} "
                    "(all-dot names and .git suffixes are not valid GitHub names)",
                    422,
                )
        labels = action_config.get("labels")
        if labels is not None and (
            not isinstance(labels, list)
            or not all(isinstance(label, str) for label in labels)
        ):
            raise AutomationRequestError(
                "action_config.labels must be a list of strings or null", 422
            )
        for key in ("title", "body"):
            template = action_config.get(key)
            if template is not None and not isinstance(template, str):
                raise AutomationRequestError(
                    f"action_config.{key} must be a string or null", 422
                )
        return {
            "owner": owner,
            "repo": repo,
            "labels": labels,
            "title": action_config.get("title"),
            "body": action_config.get("body"),
        }
    if action_type == ACTION_SLACK:
        url = action_config.get("url")
        if not isinstance(url, str) or not _SLACK_URL_RE.match(url):
            raise AutomationRequestError(
                "action_config.url must be a Slack incoming-webhook URL "
                "(https://hooks.slack.com/services/T…/B…/X… — create it in "
                "Slack under channel → Integrations → Incoming webhooks)",
                422,
            )
        try:
            validate_webhook_url(url)
        except WebhookDestinationError as exc:
            raise AutomationRequestError(str(exc), 422) from exc
        return {"url_display": mask_slack_url(url)}
    raise AutomationRequestError(
        f"Unknown action type: {action_type!r}. Valid: {', '.join(ACTION_TYPES)}"
    )


# --- GitHub token encryption ------------------------------------------------


def _generated_key_path() -> str:
    from .artifact_stores.paths import DATA_DIR

    return os.path.join(DATA_DIR, "automation-secrets.key")


def _load_or_create_generated_key(*, create: bool = True) -> Fernet:
    """Zero-config encryption key: generated once, persisted in the data dir.

    Protects stored secrets against database-file-only exfiltration. The
    env var below always wins; a full-host compromise defeats both.
    ``create=False`` for decrypt paths: reading must never mint a key.
    """
    path = _generated_key_path()
    if os.path.exists(path):
        with open(path, "rb") as handle:
            data = handle.read().strip()
        if data:
            return Fernet(data)
        raise AutomationSecretsUnavailable(
            f"generated encryption key file at {path} is empty or corrupt; "
            "delete it to regenerate (secrets encrypted under it are lost)"
        )
    if not create:
        raise AutomationSecretsUnavailable("no encryption key available")
    key = Fernet.generate_key()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another process won the create race — use its key.
        with open(path, "rb") as handle:
            return Fernet(handle.read().strip())
    try:
        written = 0
        while written < len(key):
            written += os.write(fd, key[written:])
    finally:
        os.close(fd)
    return Fernet(key)


def _fernet(*, require_env_key: bool = False, create: bool = True) -> Fernet:
    # Read at call time (not import time) so operators can set the key and
    # tests can monkeypatch it without reloading the module.
    key = os.environ.get("AUTOMATION_TOKEN_ENCRYPTION_KEY", "").strip()
    if not key:
        if require_env_key:
            raise AutomationSecretsUnavailable(
                "AUTOMATION_TOKEN_ENCRYPTION_KEY is not configured on this "
                "server; GitHub tokens cannot be stored. Set it to a Fernet "
                "key generated with Fernet.generate_key()."
            )
        return _load_or_create_generated_key(create=create)
    try:
        return Fernet(key.encode())
    except Exception as exc:
        raise AutomationSecretsUnavailable(
            "AUTOMATION_TOKEN_ENCRYPTION_KEY is not a valid Fernet key"
        ) from exc


def encrypt_github_token(token: str) -> str:
    return str(_fernet(require_env_key=True).encrypt(token.encode()).decode())


def _decrypt_with_any_key(stored: str) -> str:
    """Decrypt trying the active key first, then the other one.

    Secrets encrypted under the generated key must keep working after an
    operator sets the env key (the documented way to enable GitHub
    automations), and vice versa — switching key presence must not brick
    existing rules.
    """
    errors: list[Exception] = []
    candidates: list[str] = []
    env = os.environ.get("AUTOMATION_TOKEN_ENCRYPTION_KEY", "").strip()
    def _file_key() -> str:
        try:
            with open(_generated_key_path(), "rb") as handle:
                data = handle.read().strip()
            return data.decode()
        except OSError:
            return ""

    if env:
        candidates.append(env)
        candidates.append(_file_key())
    else:
        candidates.append(_file_key())
    for raw in candidates:
        if not raw:
            continue
        try:
            return str(Fernet(raw.encode()).decrypt(stored.encode()).decode())
        except Exception as exc:
            errors.append(exc)
    raise AutomationTokenError(
        "stored secret is undecryptable (encryption key changed?); restore "
        "the previous key, or rotate/re-save the secret on the automation"
    ) from (errors[0] if errors else None)


def decrypt_github_token(stored: str) -> str:
    return _decrypt_with_any_key(stored)


def encrypt_webhook_secret(secret: str) -> str:
    return str(_fernet().encrypt(secret.encode()).decode())


def decrypt_webhook_secret(stored: str) -> str:
    """Fernet-encrypted at rest since the encryption change; rows stored
    before that hold the raw ``whsec_…`` secret and still work."""
    if stored.startswith("whsec_"):
        return stored
    return _decrypt_with_any_key(stored)


# --- Templates ----------------------------------------------------------------


def _placeholder_values(
    data: dict[str, object], project_id: str
) -> dict[str, str]:
    def field(name: str) -> object:
        return data.get(name)

    task_hint = field("task_id") or field("batch_run_id") or ""
    task_run_ids = field("task_run_ids")
    return {
        "task_id": _value_text(field("task_id")),
        "task_hint": _value_text(task_hint),
        "task_run_id": _value_text(field("task_run_id")),
        "batch_run_id": _value_text(field("batch_run_id")),
        "trace_run_id": _value_text(field("trace_run_id")),
        "status": _value_text(field("status")),
        "pass_result": _value_text(field("pass_result")),
        "passed_checks": _value_text(field("passed_checks")),
        "failed_checks": _value_text(field("failed_checks")),
        "total_checks": _value_text(field("total_checks")),
        "passed_tasks": _value_text(field("passed_tasks")),
        "failed_tasks": _value_text(field("failed_tasks")),
        "errored_tasks": _value_text(field("errored_tasks")),
        "total_tasks": _value_text(field("total_tasks")),
        "task_run_ids": (
            ", ".join(str(item) for item in cast("list[object]", task_run_ids))
            if isinstance(task_run_ids, list)
            else ""
        ),
        "duration_ms": _value_text(field("duration_ms")),
        "project": project_id,
    }


def _value_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def render_template(
    template: str, data: dict[str, object], *, project_id: str, title: bool = False
) -> str:
    """Single left-to-right pass; substituted values are never rescanned."""
    values = _placeholder_values(data, project_id)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        text = values.get(name)
        if text is None:
            return match.group(0)
        return _CONTROL_CHARS_RE.sub("", text) if title else text

    return _TEMPLATE_RE.sub(replace, template)


def default_title() -> str:
    return "apo: {{task_hint}} — {{status}}"


def _format_duration(ms: object) -> str:
    if not isinstance(ms, (int, float)) or isinstance(ms, bool):
        return "—"
    seconds = float(ms) / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, sec = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m {sec:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes:02d}m"


def mask_slack_url(url: str) -> str:
    """Masked tail for display: the URL embeds its secret in the path."""
    tail = url[len(_SLACK_URL_PREFIX) :].split("/")
    return f"hooks.slack.com/services/…/{tail[-1][-4:]}"


def _slack_escape(text: str) -> str:
    """Escape Slack mrkdwn-significant characters in interpolated values."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _slack_header(text: str) -> str:
    # Slack header blocks cap plain_text at 150 characters.
    return text[:147] + "…" if len(text) > 150 else text


def render_slack_payload(
    data: dict[str, object],
    *,
    project_id: str,
    event_type: str,
    failing_runs: list[dict[str, object]] | None = None,
    automation_name: str | None = None,
) -> dict[str, object]:
    """Slack Block Kit message from the same content as the GitHub issue.

    Header line, a compact fields section, the failing-tasks list with
    trace links, and an attribution context block. The plain ``text`` is
    the fallback clients show when blocks are not rendered.
    """
    base_url = os.environ.get("APO_PUBLIC_URL", "").strip()

    def link_text(text: str, path: str) -> str:
        return f"<{base_url}{path}|{text}>" if base_url else text

    status = _slack_escape(_value_text(data.get("status")) or event_type)
    is_batch = all(k in data for k in ("total_tasks", "failed_tasks"))
    if is_batch:
        headline = _slack_header(
            f"Batch {status} — "
            f"{_value_text(data.get('failed_tasks'))} of "
            f"{_value_text(data.get('total_tasks'))} tasks failed"
        )
    elif data.get("task_id"):
        checks = ""
        if all(k in data for k in ("passed_checks", "total_checks")):
            checks = (
                f" ({data['passed_checks']}/{data['total_checks']} checks passed)"
            )
        headline = _slack_header(
            f"Task {status} — {_slack_escape(_value_text(data.get('task_id')))}{checks}"
        )
    else:
        headline = _slack_header(f"{event_type} — {status}")

    fields: list[dict[str, object]] = [
        {"type": "mrkdwn", "text": f"*Project*\n`{project_id}`"},
    ]
    if data.get("batch_run_id"):
        fields.append(
            {"type": "mrkdwn", "text": f"*Batch*\n`{data['batch_run_id']}`"},
        )
    run_metadata = data.get("run_metadata")
    if isinstance(run_metadata, dict):
        meta = cast("dict[str, object]", run_metadata)
        raw_trigger = meta.get("trigger")
        trigger = cast("dict[str, object]", raw_trigger) if isinstance(raw_trigger, dict) else {}
        if trigger.get("source"):
            fields.append(
                {
                    "type": "mrkdwn",
                    "text": f"*Trigger*\n{_slack_escape(_value_text(trigger['source']))}",
                },
            )
    if "duration_ms" in data:
        fields.append(
            {
                "type": "mrkdwn",
                "text": f"*Duration*\n{_format_duration(data.get('duration_ms'))}",
            },
        )

    blocks: list[dict[str, object]] = [
        {"type": "header", "text": {"type": "plain_text", "text": headline}}
    ]
    if fields:
        blocks.append({"type": "section", "fields": fields[:10]})

    enriched = failing_runs or []
    if enriched:
        lines: list[str] = []
        for run in enriched:
            trace_id = run.get("trace_run_id")
            task = _slack_escape(_value_text(run.get("task_id")))
            checks = f"{run.get('passed_checks', '—')}/{run.get('total_checks', '—')}"
            if trace_id and base_url:
                lines.append(
                    f"• `{task}` — {checks} checks — "
                    + link_text("trace ↗", f"/project/{project_id}/traces/{trace_id}")
                )
            else:
                lines.append(f"• `{task}` — {checks} checks")
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": "\n".join(lines)},
            }
        )

    links: list[str] = []
    if data.get("trace_run_id") and base_url:
        links.append(
            link_text(
                "View trace", f"/project/{project_id}/traces/{data['trace_run_id']}"
            )
        )
    if data.get("batch_run_id") and base_url:
        links.append(
            link_text(
                "View batch run", f"/project/{project_id}/runs/{data['batch_run_id']}"
            )
        )
    if links:
        blocks.append(
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": " · ".join(links)},
            }
        )
    who = f"apo automation \"{automation_name}\"" if automation_name else "an apo automation"
    blocks.append(
        {
            "type": "context",
            "elements": [
                {
                    "type": "mrkdwn",
                    "text": f"Filed automatically by {who}",
                }
            ],
        }
    )
    return {"text": headline, "blocks": blocks}


def _link(base_url: str, text: str, url: str) -> str:
    return f"[{text}]({url})" if base_url else f"{text}: {url}"


def _batch_title_text(data: dict[str, object]) -> str | None:
    failed = data.get("failed_tasks")
    total = data.get("total_tasks")
    if isinstance(failed, (int, float)) and isinstance(total, (int, float)):
        return f"{int(failed)} of {int(total)} tasks failed"
    return None


def render_default_title(data: dict[str, object], *, project_id: str) -> str:
    """Status-forward default title: the failure count beats the raw status."""
    batch_text = _batch_title_text(data)
    hint = _value_text(data.get("task_id") or data.get("batch_run_id") or "")
    if batch_text:
        return f"apo: {hint} — {batch_text}"
    return render_template(default_title(), data, project_id=project_id, title=True)


def render_default_body(
    data: dict[str, object],
    *,
    project_id: str,
    event_type: str,
    failing_runs: list[dict[str, object]] | None = None,
    automation_name: str | None = None,
) -> str:
    """Markdown issue body in the shape of real bot-filed issues.

    Verdict header, a summary table, a failing-tasks table (when the
    delivery path enriched it from the database), deep links, and an
    attribution footer. ``failing_runs`` entries carry task_id,
    passed_checks, total_checks, and trace_run_id.
    """
    base_url = os.environ.get("APO_PUBLIC_URL", "").strip()
    is_batch = all(k in data for k in ("total_tasks", "failed_tasks"))

    def abs_url(path: str) -> str:
        return f"{base_url}{path}" if base_url else path

    status = _value_text(data.get("status")) or _value_text(event_type)
    lines: list[str] = []
    if is_batch:
        batch_text = _batch_title_text(data) or status
        lines.append(f"**Batch {status}** — {batch_text}.")
    elif data.get("task_id"):
        checks = ""
        if all(k in data for k in ("passed_checks", "total_checks")):
            checks = f" ({data['passed_checks']}/{data['total_checks']} checks passed)"
        lines.append(f"**Task {status}** — `{data['task_id']}`{checks}.")

    # Summary table: two-column key/value rows read like bot issue metadata.
    rows: list[tuple[str, str]] = []
    if data.get("batch_run_id"):
        rows.append(("Batch", f"`{data['batch_run_id']}`"))
    if data.get("task_run_id"):
        rows.append(("Task run", f"`{data['task_run_id']}`"))
    run_metadata = data.get("run_metadata")
    if isinstance(run_metadata, dict):
        meta = cast("dict[str, object]", run_metadata)
        raw_trigger = meta.get("trigger")
        if isinstance(raw_trigger, dict):
            trigger = cast("dict[str, object]", raw_trigger)
        else:
            trigger = {}
        if trigger.get("source"):
            source = _value_text(trigger["source"])
            raw_schedule = meta.get("schedule")
            name = (
                cast("dict[str, object]", raw_schedule).get("name")
                if isinstance(raw_schedule, dict)
                else None
            )
            rows.append(
                ("Trigger", f"{source}" + (f" · {name}" if name else ""))
            )
    if is_batch:
        rows.append(
            (
                "Result",
                "{passed} passed · {failed} failed · {errored} errored".format(
                    passed=data.get("passed_tasks", "—"),
                    failed=data.get("failed_tasks", "—"),
                    errored=data.get("errored_tasks", 0),
                ),
            )
        )
    if all(k in data for k in ("passed_checks", "total_checks")):
        rows.append(
            (
                "Checks",
                f"{data['passed_checks']}/{data['total_checks']} passed",
            )
        )
    if "duration_ms" in data:
        rows.append(("Duration", _format_duration(data.get("duration_ms"))))
    rows.append(("Project", f"`{project_id}`"))
    if rows:
        lines.append("")
        lines.append("| | |")
        lines.append("| --- | --- |")
        lines.extend(f"| {key} | {value} |" for key, value in rows)

    # Failing-tasks table — the section a responder actually wants. Only
    # possible when the delivery path enriched from the run database;
    # otherwise fall back to raw run ids from the payload.
    enriched = failing_runs or []
    if enriched:
        lines.append("")
        lines.append("### Failing tasks")
        lines.append("")
        lines.append("| Task | Checks | Trace |")
        lines.append("| --- | --- | --- |")
        for run in enriched:
            task = f"`{_value_text(run.get('task_id'))}`"
            checks = f"{run.get('passed_checks', '—')}/{run.get('total_checks', '—')}"
            trace_id = run.get("trace_run_id")
            trace = (
                _link(
                    base_url,
                    "open ↗",
                    abs_url(f"/project/{project_id}/traces/{trace_id}"),
                )
                if trace_id
                else "—"
            )
            lines.append(f"| {task} | {checks} | {trace} |")
    else:
        task_run_ids = data.get("task_run_ids")
        if isinstance(task_run_ids, list) and task_run_ids:
            ids = cast("list[object]", task_run_ids)
            lines.append("")
            lines.append(
                "Task runs: " + ", ".join(f"`{item}`" for item in ids)
            )

    # Deep links (or raw paths when the public URL is unset).
    lines.append("")
    links: list[str] = []
    if data.get("task_run_id"):
        links.append(
            _link(
                base_url,
                "View task run",
                abs_url(f"/project/{project_id}/runs/task/{data['task_run_id']}"),
            )
        )
    if data.get("trace_run_id"):
        links.append(
            _link(
                base_url,
                "View trace",
                abs_url(f"/project/{project_id}/traces/{data['trace_run_id']}"),
            )
        )
    if data.get("batch_run_id"):
        links.append(
            _link(
                base_url,
                "View batch run",
                abs_url(f"/project/{project_id}/runs/{data['batch_run_id']}"),
            )
        )
    if links:
        lines.append(" · ".join(links))

    # Attribution footer names the rule that fired — accountability in the
    # artifact itself.
    lines.append("")
    lines.append("---")
    who = f"apo automation “{automation_name}”" if automation_name else "an apo automation"
    posted_by = (
        f"[{who}]({base_url}/project/{project_id}/automations)" if base_url else who
    )
    lines.append(f"Filed automatically by {posted_by}.")
    return "\n".join(lines)




# --- Sample events (for the test route) ---------------------------------------


def build_sample_event_data(event_type: str) -> dict[str, object]:
    now = datetime.now(timezone.utc).isoformat()
    if event_type in ("batch_run.completed", "batch_run.failed"):
        return {
            "batch_run_id": "test-batch-run",
            "status": "failed" if event_type == "batch_run.failed" else "completed",
            "total_tasks": 3,
            "passed_tasks": 1,
            "failed_tasks": 2,
            "errored_tasks": 0,
            "duration_ms": 5000.0,
            "started_at": now,
            "completed_at": now,
            "run_metadata": {
                "trigger": {"source": "test"},
                "schedule": {"id": "test-schedule", "name": "test-schedule"},
            },
        }
    if event_type == "task_run.trace_claimed":
        return {
            "task_run_id": "test-task-run",
            "trace_run_id": "test-trace-run",
            "batch_run_id": "test-batch-run",
            "status": "running",
        }
    status = {
        "task_run.started": "running",
        "task_run.completed": "failed",
        "task_run.error": "error",
    }.get(event_type, "failed")
    return {
        "task_run_id": "test-task-run",
        "batch_run_id": "test-batch-run",
        "task_id": "test-task",
        "status": status,
        "pass_result": False if status == "failed" else None,
        "total_checks": 3,
        "passed_checks": 1,
        "failed_checks": 2,
        "duration_ms": 1234.5,
        "total_cost": 0.01,
        "trace_run_id": "test-trace-run",
        "started_at": now,
        "completed_at": now,
    }


# --- Dispatch -----------------------------------------------------------------


async def fire_automations_for_event(project: str, event: object) -> None:
    """Match a run event against the project's automations and dispatch."""
    event_type = getattr(event, "event_type", "")
    data: dict[str, object] = dict(getattr(event, "data", {}) or {})

    planned: list[tuple[str, str]] = []
    with Session(engine) as session:
        automations = session.exec(
            select(AutomationDB).where(
                col(AutomationDB.project_id) == project,
                col(AutomationDB.enabled) == True,  # noqa: E712
                col(AutomationDB.event_type) == event_type,
            )
        ).all()
        for automation in automations:
            # One failing automation must not abort the rest for this event.
            try:
                if not conditions_match(automation.conditions, data):
                    continue
                execution = AutomationExecutionDB(
                    automation_id=automation.id,
                    project_id=project,
                    event_type=event_type,
                    input=data,
                )
                session.add(execution)
                session.commit()
                session.refresh(execution)
                # Prune at insert time so a saturated delivery semaphore
                # (queued, never-started deliveries) cannot grow the log.
                _prune_executions(session, automation.id)
                assert execution.id is not None and automation.id is not None
                planned.append((automation.id, execution.id))
            except Exception:
                logger.exception(
                    "Automation %s failed during match/dispatch", automation.id
                )

    for automation_id, execution_id in planned:
        task = asyncio.create_task(
            _deliver(automation_id, execution_id, project, event_type, data)
        )
        _delivery_tasks.add(task)
        task.add_done_callback(_delivery_tasks.discard)


_delivery_tasks: set[asyncio.Task[None]] = set()
_semaphore: asyncio.Semaphore | None = None
_client: httpx.AsyncClient | None = None


def _shared_client() -> httpx.AsyncClient:
    # Created lazily and nulled by stop_automation_deliveries (and tests) so
    # each event loop gets a fresh client instead of one bound to a closed loop.
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS)
    return _client


def _prune_executions(session: Session, automation_id: str) -> None:
    keep_ids = session.exec(
        select(AutomationExecutionDB.id)
        .where(col(AutomationExecutionDB.automation_id) == automation_id)
        .order_by(
            as_column(cast(object, AutomationExecutionDB.created_at)).desc(),
            as_column(cast(object, AutomationExecutionDB.id)).desc(),
        )
        .limit(PRUNE_KEEP)
    ).all()
    if len(keep_ids) < PRUNE_KEEP:
        return
    session.exec(
        sa_delete(AutomationExecutionDB).where(
            col(AutomationExecutionDB.automation_id) == automation_id,
            col(AutomationExecutionDB.id).not_in(keep_ids),
        )
    )
    session.commit()


async def _deliver(
    automation_id: str,
    execution_id: str,
    project: str,
    event_type: str,
    data: dict[str, object],
    *,
    is_test: bool = False,
) -> None:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(DELIVERY_CONCURRENCY)
    assert _semaphore is not None
    semaphore = _semaphore
    client = _shared_client()
    async with semaphore:
        with Session(engine) as session:
            automation = session.get(AutomationDB, automation_id)
            if automation is None:
                return
            snapshot = _automation_snapshot(automation)
        await _execute_delivery(
            client, snapshot, execution_id, project, event_type, data, is_test=is_test
        )


def _automation_snapshot(automation: AutomationDB) -> dict[str, object]:
    return {
        "id": automation.id,
        "action_type": automation.action_type,
        "action_config": dict(automation.action_config or {}),
        "secret": automation.secret,
        "github_token_encrypted": automation.github_token_encrypted,
        "slack_webhook_url_encrypted": automation.slack_webhook_url_encrypted,
    }


async def deliver_test_event(
    automation: AutomationDB, session: Session
) -> tuple[bool, str | None]:
    """Deliver a synthetic event inline (the /test route); skip health updates."""
    data = build_sample_event_data(automation.event_type)
    data["__test"] = True
    if not conditions_match(automation.conditions, data):
        return False, "sample event does not match automation conditions"
    assert automation.id is not None
    execution = AutomationExecutionDB(
        automation_id=automation.id,
        project_id=automation.project_id,
        event_type=automation.event_type,
        input=data,
    )
    session.add(execution)
    session.commit()
    session.refresh(execution)
    _prune_executions(session, automation.id)
    assert execution.id is not None
    success, _, error = await _execute_delivery(
        _shared_client(),
        _automation_snapshot(automation),
        execution.id,
        automation.project_id,
        automation.event_type,
        data,
        is_test=True,
    )
    return success, error


async def _execute_delivery(
    client: httpx.AsyncClient,
    snapshot: dict[str, object],
    execution_id: str,
    project: str,
    event_type: str,
    data: dict[str, object],
    *,
    is_test: bool,
) -> tuple[bool, dict[str, object] | None, str | None]:
    _mark_execution_started(execution_id)
    automation_id = str(snapshot["id"])
    try:
        if snapshot["action_type"] == ACTION_WEBHOOK:
            success, output, error = await _deliver_webhook_action(
                client, snapshot, automation_id, execution_id, project, event_type, data
            )
        elif snapshot["action_type"] == ACTION_SLACK:
            success, output, error = await _deliver_slack_action(
                client, snapshot, project, event_type, data
            )
        else:
            success, output, error = await _deliver_github_issue_action(
                client, snapshot, project, event_type, data
            )
    except Exception as exc:
        logger.exception("Automation %s delivery crashed", automation_id)
        success, output, error = False, None, str(exc)
    _record_delivery_outcome(
        automation_id, execution_id, success, output, error, is_test=is_test
    )
    return success, output, error


async def _deliver_webhook_action(
    client: httpx.AsyncClient,
    snapshot: dict[str, object],
    automation_id: str,
    execution_id: str,
    project: str,
    event_type: str,
    data: dict[str, object],
) -> tuple[bool, dict[str, object] | None, str | None]:
    config = cast("dict[str, object]", snapshot["action_config"])
    url = str(config.get("url", ""))
    raw_secret = snapshot["secret"]
    if not isinstance(raw_secret, str) or not raw_secret:
        return False, None, "automation has no signing secret"
    try:
        secret = decrypt_webhook_secret(raw_secret)
    except AutomationTokenError as exc:
        return False, None, str(exc)

    # Delivery-time SSRF guard: re-resolve so a URL whose DNS changed to an
    # internal address after configuration cannot be reached.
    try:
        assert_public_destination(url)
    except WebhookDestinationError as exc:
        return False, None, str(exc)

    envelope = {
        "event_type": event_type,
        "project": project,
        "data": data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "automation": {
            "automation_id": automation_id,
            "automation_name": _automation_name(automation_id),
            "execution_id": execution_id,
        },
    }
    payload_bytes = json.dumps(envelope, default=str).encode()
    headers = {
        "Content-Type": "application/json",
        "X-Automation-Signature": sign_payload(payload_bytes, secret),
        "X-Automation-Event": event_type,
        "X-Automation-Delivery-ID": f"{automation_id}-{execution_id}",
    }
    last_error: str | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = await client.post(url, content=payload_bytes, headers=headers)
            if 200 <= resp.status_code < 300:
                return True, {"http_status": resp.status_code}, None
            last_error = f"HTTP {resp.status_code}"
        except httpx.HTTPError as exc:
            last_error = str(exc)
        if attempt < MAX_RETRIES:
            await _retry_delay()
    return False, None, last_error


async def _retry_delay() -> None:
    await asyncio.sleep(1)


async def await_pending_deliveries() -> None:
    """Wait for in-flight delivery tasks without cancelling them.

    Used by tests to make fan-out assertions deterministic; shutdown uses
    :func:`stop_automation_deliveries` instead (cancel + drain).
    """
    tasks = list(_delivery_tasks)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def _deliver_github_issue_action(
    client: httpx.AsyncClient,
    snapshot: dict[str, object],
    project: str,
    event_type: str,
    data: dict[str, object],
) -> tuple[bool, dict[str, object] | None, str | None]:
    config = cast("dict[str, object]", snapshot["action_config"])
    owner = str(config.get("owner", ""))
    repo = str(config.get("repo", ""))
    stored = snapshot["github_token_encrypted"]
    if not isinstance(stored, str) or not stored:
        return False, None, "automation has no stored GitHub token"
    try:
        token = decrypt_github_token(stored)
    except AutomationTokenError as exc:
        return False, None, str(exc)

    title_template = config.get("title")
    title = (
        render_template(title_template, data, project_id=project, title=True)
        if isinstance(title_template, str)
        else render_default_title(data, project_id=project)
    )
    body_template = config.get("body")
    if isinstance(body_template, str):
        body = render_template(body_template, data, project_id=project)
    else:
        # Enrich from the run database so the issue lists the actual failing
        # tasks with trace links; enrichment failure must never fail the
        # delivery — the payload fallback still renders a complete issue.
        failing_runs: list[dict[str, object]] = []
        batch_run_id = data.get("batch_run_id")
        automation_id = str(snapshot["id"])
        if isinstance(batch_run_id, str) and batch_run_id:
            try:
                failing_runs = _failing_task_runs(project, batch_run_id)
            except Exception:
                logger.warning(
                    "Automation %s: failing-run enrichment failed", automation_id
                )
        body = render_default_body(
            data,
            project_id=project,
            event_type=event_type,
            failing_runs=failing_runs,
            automation_name=_automation_name(automation_id),
        )
    issue: dict[str, object] = {"title": title, "body": body}
    labels = config.get("labels")
    if isinstance(labels, list) and labels:
        issue["labels"] = labels

    url = f"{GITHUB_API_BASE}/repos/{owner}/{repo}/issues"
    try:
        resp = await client.post(
            url,
            json=issue,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
            },
        )
    except httpx.HTTPError as exc:
        return False, None, str(exc)
    if 200 <= resp.status_code < 300:
        issue_url = str(resp.json().get("html_url") or "")
        return True, {"issue_url": issue_url}, None
    return (
        False,
        None,
        f"GitHub API returned {resp.status_code}: {resp.text[:ERROR_MESSAGE_MAX_CHARS]}",
    )


def _failing_task_runs(
    project: str, batch_run_id: str, limit: int = 10
) -> list[dict[str, object]]:
    """Failed task runs of a batch, for the issue's failing-tasks table.

    Scoped through the batch row's project — task runs carry no project
    column of their own, and an id from another project's event must never
    enrich this issue.
    """
    with Session(engine) as session:
        batch = session.exec(
            select(AgentTaskBatchRunDB.id).where(
                col(AgentTaskBatchRunDB.id) == batch_run_id,
                col(AgentTaskBatchRunDB.project) == project,
            )
        ).first()
        if batch is None:
            return []
        runs = session.exec(
            select(AgentTaskRunDB)
            .where(
                col(AgentTaskRunDB.batch_run_id) == batch_run_id,
                col(AgentTaskRunDB.pass_result) == False,  # noqa: E712
            )
            .limit(limit)
        ).all()
        return [
            {
                "task_id": run.task_id,
                "passed_checks": run.passed_checks,
                "total_checks": run.total_checks,
                "trace_run_id": run.trace_run_id,
            }
            for run in runs
        ]


async def _deliver_slack_action(
    client: httpx.AsyncClient,
    snapshot: dict[str, object],
    project: str,
    event_type: str,
    data: dict[str, object],
) -> tuple[bool, dict[str, object] | None, str | None]:
    stored = snapshot["slack_webhook_url_encrypted"]
    if not isinstance(stored, str) or not stored:
        return False, None, "automation has no stored Slack webhook URL"
    try:
        url = decrypt_webhook_secret(stored)
    except AutomationTokenError:
        return (
            False,
            None,
            "stored Slack webhook URL is undecryptable (encryption key "
            "changed?); re-save the URL on the automation",
        )
    # Same delivery-time guard as the webhook action, for symmetry.
    try:
        assert_public_destination(url)
    except WebhookDestinationError as exc:
        return False, None, str(exc)

    failing_runs: list[dict[str, object]] = []
    batch_run_id = data.get("batch_run_id")
    if isinstance(batch_run_id, str) and batch_run_id:
        try:
            failing_runs = _failing_task_runs(project, batch_run_id)
        except Exception:
            logger.warning("Slack delivery: failing-run enrichment failed")

    payload = render_slack_payload(
        data,
        project_id=project,
        event_type=event_type,
        failing_runs=failing_runs,
        automation_name=_automation_name(str(snapshot["id"])),
    )
    # Single-shot by choice: a retried Slack post is a duplicate message in
    # the channel, and a dropped one is visible as such. Slack 429s surface
    # as execution errors like any other failure.
    try:
        resp = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        return False, None, str(exc)
    if 200 <= resp.status_code < 300:
        return True, {"http_status": resp.status_code}, None
    return (
        False,
        None,
        f"Slack returned {resp.status_code}: {resp.text[:ERROR_MESSAGE_MAX_CHARS]}",
    )


def _automation_name(automation_id: str) -> str:
    with Session(engine) as session:
        automation = session.get(AutomationDB, automation_id)
        return automation.name if automation else automation_id


def _mark_execution_started(execution_id: str) -> None:
    with Session(engine) as session:
        execution = session.get(AutomationExecutionDB, execution_id)
        if execution is None:
            return
        execution.started_at = datetime.now(timezone.utc)
        session.add(execution)
        session.commit()


def _record_delivery_outcome(
    automation_id: str,
    execution_id: str,
    success: bool,
    output: dict[str, object] | None,
    error: str | None,
    *,
    is_test: bool,
) -> None:
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        execution = session.get(AutomationExecutionDB, execution_id)
        if execution is not None:
            execution.status = "completed" if success else "error"
            execution.output = output
            execution.error = (
                error[:ERROR_MESSAGE_MAX_CHARS] if error is not None else None
            )
            execution.finished_at = now
            session.add(execution)
        if not is_test:
            automation = session.get(AutomationDB, automation_id)
            if automation is not None:
                automation.last_delivery_at = now
                automation.last_delivery_status = (
                    "success" if success else "failure"
                )
                failures, disable = next_delivery_health(
                    success, automation.consecutive_failures
                )
                automation.consecutive_failures = failures
                if disable:
                    automation.enabled = False
                    logger.warning(
                        "Automation %s disabled after %d consecutive failures",
                        automation_id,
                        failures,
                    )
                session.add(automation)
        session.commit()


# --- Lifecycle -----------------------------------------------------------------


async def dispatch_execution_delivery(
    automation_id: str,
    execution_id: str,
    project: str,
    event_type: str,
    data: dict[str, object],
) -> None:
    """Deliver a recorded execution; public wrapper so the window evaluator
    can dispatch through the same path as event fires (semaphore, retries,
    health auto-disable)."""
    await _deliver(automation_id, execution_id, project, event_type, data)


def recover_stale_automations(session: Session) -> None:
    """Mark orphaned pending executions as error; never retry a delivery.

    Deliveries only start after app startup completes, so any pending row at
    startup was interrupted by a restart. Retrying could double-fire side
    effects (duplicate GitHub issues are worse than a missed notification).
    """
    pending = session.exec(
        select(AutomationExecutionDB).where(
            AutomationExecutionDB.status == "pending"
        )
    ).all()
    now = datetime.now(timezone.utc)
    for execution in pending:
        execution.status = "error"
        execution.error = "delivery interrupted by restart"
        execution.finished_at = now
        session.add(execution)
    if pending:
        session.commit()
        logger.info("Marked %d interrupted automation executions as error", len(pending))


async def stop_automation_deliveries() -> None:
    """Cancel and drain in-flight deliveries; close the shared client."""
    global _client, _semaphore
    tasks = list(_delivery_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        try:
            await asyncio.wait_for(
                asyncio.gather(*tasks, return_exceptions=True), timeout=5
            )
        except TimeoutError:
            logger.warning("Automation delivery drain timed out")
    if _client is not None:
        await _client.aclose()
    _delivery_tasks.clear()
    _client = None
    _semaphore = None
