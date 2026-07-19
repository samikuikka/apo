from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from apo_langchain.callback_handler import ApoCallbackHandler
from apo_langchain.mapping import (
    _is_agent,
    extract_model_name,
    extract_name,
    format_output,
    get_observation_type,
)


class TestGetObservationType:
    def test_chat_model_start_returns_generation(self) -> None:
        assert get_observation_type("on_chat_model_start") == "GENERATION"

    def test_tool_start_returns_tool(self) -> None:
        assert get_observation_type("on_tool_start") == "TOOL"

    def test_retriever_start_returns_retriever(self) -> None:
        assert get_observation_type("on_retriever_start") == "RETRIEVER"

    def test_chain_start_returns_chain(self) -> None:
        assert get_observation_type("on_chain_start") == "CHAIN"

    def test_chain_start_with_agent_class(self) -> None:
        serialized: dict[str, object] = {"name": "AgentExecutor"}
        assert get_observation_type("on_chain_start", serialized) == "AGENT"

    def test_chain_start_with_agent_module(self) -> None:
        serialized: dict[str, object] = {"module": "langchain.agents.executor"}
        assert get_observation_type("on_chain_start", serialized) == "AGENT"

    def test_chain_start_with_non_agent(self) -> None:
        serialized: dict[str, object] = {"name": "MyChain"}
        assert get_observation_type("on_chain_start", serialized) == "CHAIN"

    def test_unknown_event_returns_span(self) -> None:
        assert get_observation_type("on_unknown_event") == "SPAN"


class TestIsAgent:
    def test_agent_executor(self) -> None:
        assert _is_agent({"name": "AgentExecutor"}) is True

    def test_non_agent(self) -> None:
        assert _is_agent({"name": "SequentialChain"}) is False

    def test_none_serialized(self) -> None:
        assert _is_agent(None) is False

    def test_agent_module_prefix(self) -> None:
        assert _is_agent({"module": "langchain.agents.types"}) is True

    def test_agent_klass(self) -> None:
        assert _is_agent({"klass": "AgentExecutor"}) is True


class TestExtractModelName:
    def test_from_serialized_name(self) -> None:
        assert extract_model_name({"name": "ChatOpenAI"}) == "ChatOpenAI"

    def test_from_kwargs_model(self) -> None:
        serialized: dict[str, object] = {"kwargs": {"model": "gpt-4"}}
        assert extract_model_name(serialized) == "gpt-4"

    def test_none_serialized(self) -> None:
        assert extract_model_name(None) == "unknown"

    def test_no_name(self) -> None:
        assert extract_model_name({}) == "unknown"


class TestExtractName:
    def test_with_name(self) -> None:
        assert extract_name({"name": "MyChain"}) == "MyChain"

    def test_none_serialized(self) -> None:
        assert extract_name(None) is None

    def test_no_name(self) -> None:
        assert extract_name({}) is None


class TestFormatOutput:
    def test_none(self) -> None:
        assert format_output(None) == {}

    def test_dict(self) -> None:
        assert format_output({"key": "value"}) == {"key": "value"}

    def test_string(self) -> None:
        assert format_output("hello") == {"content": "hello"}

    def test_object_with_content(self) -> None:
        msg = MagicMock()
        msg.content = "test response"
        assert format_output(msg) == {"content": "test response"}


class TestCallbackHandlerChain:
    def test_chain_and_llm_creates_hierarchy(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=100,
        )

        chain_run_id = uuid.uuid4()
        llm_run_id = uuid.uuid4()

        with patch.object(handler._client, "_send_batch"):
            handler.on_chain_start(
                serialized={"name": "MyChain"},
                inputs={"input": "hello"},
                run_id=chain_run_id,
                parent_run_id=None,
            )
            handler.on_chat_model_start(
                serialized={"name": "ChatOpenAI", "kwargs": {"model": "gpt-4"}},
                messages=[],
                run_id=llm_run_id,
                parent_run_id=chain_run_id,
            )
            mock_response = MagicMock()
            mock_response.llm_output = None
            mock_response.generations = []
            mock_response.usage_metadata = {"input_tokens": 10, "output_tokens": 5}
            handler.on_chat_model_end(
                response=mock_response,
                run_id=llm_run_id,
            )
            handler.on_chain_end(
                outputs={"output": "world"},
                run_id=chain_run_id,
            )

        events = handler._client._queue
        assert len(events) == 5

        types = [e["type"] for e in events]
        assert "run-create" in types
        assert types.count("call-create") == 2
        assert types.count("call-update") == 2

        run_create = next(e for e in events if e["type"] == "run-create")
        assert run_create["body"]["id"] == str(chain_run_id)

        chain_create = next(
            e
            for e in events
            if e["type"] == "call-create"
            and e["body"].get("observation_type") == "CHAIN"
        )
        assert chain_create["body"]["step_name"] == "MyChain"

        llm_create = next(
            e
            for e in events
            if e["type"] == "call-create"
            and e["body"].get("observation_type") == "GENERATION"
        )
        assert llm_create["body"]["parent_call_id"] == str(chain_run_id)
        assert llm_create["body"]["model"] == "gpt-4"


class TestCallbackHandlerTool:
    def test_tool_execution_creates_tool_span(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=100,
        )

        parent_id = uuid.uuid4()
        tool_id = uuid.uuid4()

        with patch.object(handler._client, "_send_batch"):
            handler.on_tool_start(
                serialized={"name": "Calculator"},
                input_str="2 + 2",
                run_id=tool_id,
                parent_run_id=parent_id,
            )
            handler.on_tool_end(
                output="4",
                run_id=tool_id,
            )

        events = handler._client._queue
        tool_create = next(
            e for e in events if e["type"] == "call-create"
        )
        assert tool_create["body"]["observation_type"] == "TOOL"
        assert tool_create["body"]["tool_name"] == "Calculator"


class TestCallbackHandlerRetriever:
    def test_retriever_creates_retriever_span(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=100,
        )

        parent_id = uuid.uuid4()
        retriever_id = uuid.uuid4()

        with patch.object(handler._client, "_send_batch"):
            handler.on_retriever_start(
                serialized={"name": "VectorStoreRetriever"},
                query="test query",
                run_id=retriever_id,
                parent_run_id=parent_id,
            )
            handler.on_retriever_end(
                documents=[],
                run_id=retriever_id,
            )

        events = handler._client._queue
        retriever_create = next(
            e for e in events if e["type"] == "call-create"
        )
        assert retriever_create["body"]["observation_type"] == "RETRIEVER"


class TestCallbackHandlerError:
    def test_llm_error_creates_error_span(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=100,
        )

        run_id = uuid.uuid4()

        with patch.object(handler._client, "_send_batch"):
            handler.on_chain_start(
                serialized={"name": "MyChain"},
                inputs={},
                run_id=run_id,
                parent_run_id=None,
            )
            handler.on_llm_error(
                error=Exception("Rate limit exceeded"),
                run_id=run_id,
            )

        events = handler._client._queue
        error_update = next(
            e for e in events if e["type"] == "call-update"
        )
        assert error_update["body"]["level"] == "ERROR"
        assert "Rate limit exceeded" in error_update["body"]["status_message"]


class TestCallbackHandlerIngestionFailure:
    def test_handler_survives_ingestion_failure(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=1,
        )

        with patch.object(
            handler._client, "_send_batch", side_effect=Exception("Connection refused")
        ):
            handler.on_chain_start(
                serialized={"name": "MyChain"},
                inputs={},
                run_id=uuid.uuid4(),
                parent_run_id=None,
            )

        assert len(handler._client._queue) >= 1


class TestCallbackHandlerMultipleRoots:
    def test_multiple_root_runs_create_separate_traces(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=100,
        )

        run1 = uuid.uuid4()
        run2 = uuid.uuid4()

        with patch.object(handler._client, "_send_batch"):
            handler.on_chain_start(
                serialized={"name": "Chain1"},
                inputs={},
                run_id=run1,
                parent_run_id=None,
            )
            handler.on_chain_start(
                serialized={"name": "Chain2"},
                inputs={},
                run_id=run2,
                parent_run_id=None,
            )

        events = handler._client._queue
        run_creates = [e for e in events if e["type"] == "run-create"]
        assert len(run_creates) == 2
        assert run_creates[0]["body"]["id"] == str(run1)
        assert run_creates[1]["body"]["id"] == str(run2)


class TestCallbackHandlerAgentDetection:
    def test_agent_detected_from_serialized_class_path(self) -> None:
        handler = ApoCallbackHandler(
            endpoint="http://localhost:8000",
            project="test-project",
            flush_threshold=100,
        )

        run_id = uuid.uuid4()

        with patch.object(handler._client, "_send_batch"):
            handler.on_chain_start(
                serialized={"name": "AgentExecutor"},
                inputs={"input": "What is 2+2?"},
                run_id=run_id,
                parent_run_id=None,
            )

        events = handler._client._queue
        agent_create = next(e for e in events if e["type"] == "call-create")
        assert agent_create["body"]["observation_type"] == "AGENT"
