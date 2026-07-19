from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, override

from langchain_core.callbacks.base import BaseCallbackHandler

from .client import IngestionClient
from .mapping import (
    extract_model_name,
    extract_name,
    extract_token_usage,
    format_output,
    get_observation_type,
)

logger = logging.getLogger("apo_langchain")

type JsonMap = dict[str, object]


class ApoCallbackHandler(BaseCallbackHandler):
    _project: str
    _environment: str
    _session_id: str | None
    _tags: list[str]
    _client: IngestionClient

    def __init__(
        self,
        endpoint: str = "http://localhost:8000",
        project: str = "default",
        environment: str = "default",
        session_id: str | None = None,
        tags: list[str] | None = None,
        flush_threshold: int = 10,
    ) -> None:
        self._project = project
        self._environment = environment
        self._session_id = session_id
        self._tags = tags or []
        self._client = IngestionClient(
            endpoint=endpoint,
            flush_threshold=flush_threshold,
        )
        self._root_runs: set[str] = set()

    def flush(self) -> None:
        self._client.flush()

    def close(self) -> None:
        self._client.close()

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _common_call_fields(self) -> JsonMap:
        fields: JsonMap = {
            "project": self._project,
            "environment": self._environment,
        }
        if self._session_id:
            fields["session_id"] = self._session_id
        if self._tags:
            fields["tags"] = self._tags
        return fields

    def _ensure_root_run(self, run_id: str, parent_run_id: str | None) -> None:
        if parent_run_id is None and run_id not in self._root_runs:
            self._root_runs.add(run_id)
            self._client.enqueue({
                "type": "run-create",
                "body": {
                    "id": run_id,
                    "project": self._project,
                    "environment": self._environment,
                    **({
                        "session_id": self._session_id,
                    } if self._session_id else {}),
                    **({"tags": self._tags} if self._tags else {}),
                },
            })

    @override
    def on_llm_start(
        self,
        serialized: dict[str, Any],
        prompts: list[str],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        _ = prompts
        self._on_model_start(
            serialized,
            run_id,
            parent_run_id,
            tags,
            **kwargs,
        )

    @override
    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        _ = messages, metadata
        self._on_model_start(
            serialized,
            run_id,
            parent_run_id,
            tags,
            **kwargs,
        )

    def _on_model_start(
        self,
        serialized: dict[str, Any],
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None,
        tags: list[str] | None,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        parent_str = str(parent_run_id) if parent_run_id else None
        self._ensure_root_run(run_id_str, parent_str)

        model_name = extract_model_name(serialized)

        body: JsonMap = {
            "id": run_id_str,
            "model": model_name,
            "observation_type": "GENERATION",
            "created_at": self._now_iso(),
            "level": "DEFAULT",
            "input": {},
            **self._common_call_fields(),
        }
        if parent_str:
            body["parent_call_id"] = parent_str
            body["run_id"] = self._find_root(parent_str)
        else:
            body["run_id"] = run_id_str

        invocation_params = kwargs.get("invocation_params")
        if isinstance(invocation_params, dict):
            body["metadata"] = invocation_params

        if tags:
            merged = list(set(self._tags + tags))
            body["tags"] = merged

        self._client.enqueue({"type": "call-create", "body": body})

    @override
    def on_llm_end(
        self,
        response: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        self._on_model_end(response, run_id)

    def on_chat_model_end(
        self,
        response: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        _ = kwargs
        self._on_model_end(response, run_id)

    def _on_model_end(
        self,
        response: Any,
        run_id: uuid.UUID,
    ) -> None:
        run_id_str = str(run_id)
        output = format_output(response)
        tokens = extract_token_usage(response)

        body: JsonMap = {
            "id": run_id_str,
            "output": output,
            "end_time": self._now_iso(),
        }
        if tokens["prompt_tokens"] is not None:
            body["prompt_tokens"] = tokens["prompt_tokens"]
        if tokens["completion_tokens"] is not None:
            body["completion_tokens"] = tokens["completion_tokens"]

        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_llm_error(
        self,
        error: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        self._on_model_error(error, run_id)

    def on_chat_model_error(
        self,
        error: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        _ = kwargs
        self._on_model_error(error, run_id)

    def _on_model_error(
        self,
        error: Any,
        run_id: uuid.UUID,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "level": "ERROR",
            "status_message": str(error),
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_chain_start(
        self,
        serialized: dict[str, Any],
        inputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        _ = metadata
        run_id_str = str(run_id)
        parent_str = str(parent_run_id) if parent_run_id else None
        self._ensure_root_run(run_id_str, parent_str)

        obs_type = get_observation_type("on_chain_start", serialized)
        name = extract_name(serialized) or "chain"

        body: JsonMap = {
            "id": run_id_str,
            "model": "unknown",
            "observation_type": obs_type,
            "step_name": name,
            "created_at": self._now_iso(),
            "level": "DEFAULT",
            "input": dict(inputs),
            **self._common_call_fields(),
        }
        if parent_str:
            body["parent_call_id"] = parent_str
            body["run_id"] = self._find_root(parent_str)
        else:
            body["run_id"] = run_id_str

        if tags:
            merged = list(set(self._tags + tags))
            body["tags"] = merged

        self._client.enqueue({"type": "call-create", "body": body})

    @override
    def on_chain_end(
        self,
        outputs: dict[str, Any],
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "output": dict(outputs),
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_chain_error(
        self,
        error: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "level": "ERROR",
            "status_message": str(error),
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_tool_start(
        self,
        serialized: dict[str, Any],
        input_str: str,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        _ = metadata
        run_id_str = str(run_id)
        parent_str = str(parent_run_id) if parent_run_id else None
        self._ensure_root_run(run_id_str, parent_str)

        name = extract_name(serialized) or "tool"

        body: JsonMap = {
            "id": run_id_str,
            "model": "unknown",
            "observation_type": "TOOL",
            "tool_name": name,
            "step_name": name,
            "created_at": self._now_iso(),
            "level": "DEFAULT",
            "input": {"input": input_str},
            **self._common_call_fields(),
        }
        if parent_str:
            body["parent_call_id"] = parent_str
            body["run_id"] = self._find_root(parent_str)
        else:
            body["run_id"] = run_id_str

        if tags:
            merged = list(set(self._tags + tags))
            body["tags"] = merged

        self._client.enqueue({"type": "call-create", "body": body})

    @override
    def on_tool_end(
        self,
        output: str,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "output": {"content": str(output)},
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_tool_error(
        self,
        error: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "level": "ERROR",
            "status_message": str(error),
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_retriever_start(
        self,
        serialized: dict[str, Any],
        query: str,
        *,
        run_id: uuid.UUID,
        parent_run_id: uuid.UUID | None = None,
        tags: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> None:
        _ = metadata
        run_id_str = str(run_id)
        parent_str = str(parent_run_id) if parent_run_id else None
        self._ensure_root_run(run_id_str, parent_str)

        name = extract_name(serialized) or "retriever"

        body: JsonMap = {
            "id": run_id_str,
            "model": "unknown",
            "observation_type": "RETRIEVER",
            "step_name": name,
            "created_at": self._now_iso(),
            "level": "DEFAULT",
            "input": {"query": query},
            **self._common_call_fields(),
        }
        if parent_str:
            body["parent_call_id"] = parent_str
            body["run_id"] = self._find_root(parent_str)
        else:
            body["run_id"] = run_id_str

        if tags:
            merged = list(set(self._tags + tags))
            body["tags"] = merged

        self._client.enqueue({"type": "call-create", "body": body})

    @override
    def on_retriever_end(
        self,
        documents: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "output": format_output(documents),
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    @override
    def on_retriever_error(
        self,
        error: Any,
        *,
        run_id: uuid.UUID,
        **kwargs: Any,
    ) -> None:
        run_id_str = str(run_id)
        body: JsonMap = {
            "id": run_id_str,
            "level": "ERROR",
            "status_message": str(error),
            "end_time": self._now_iso(),
        }
        self._client.enqueue({"type": "call-update", "body": body})

    def _find_root(self, run_id: str) -> str:
        return run_id if run_id in self._root_runs else run_id
