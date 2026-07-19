from __future__ import annotations

from apo_langchain.mapping import (
    _is_agent,
    extract_model_name,
    extract_name,
    format_messages_as_dicts,
    format_output,
    get_observation_type,
)


class TestGetObservationType:
    def test_chat_model_returns_generation(self) -> None:
        assert get_observation_type("on_chat_model_start") == "GENERATION"

    def test_tool_returns_tool(self) -> None:
        assert get_observation_type("on_tool_start") == "TOOL"

    def test_retriever_returns_retriever(self) -> None:
        assert get_observation_type("on_retriever_start") == "RETRIEVER"

    def test_chain_returns_chain(self) -> None:
        assert get_observation_type("on_chain_start") == "CHAIN"

    def test_chain_with_agent_name(self) -> None:
        assert get_observation_type("on_chain_start", {"name": "AgentExecutor"}) == "AGENT"

    def test_chain_with_non_agent_name(self) -> None:
        assert get_observation_type("on_chain_start", {"name": "LLMChain"}) == "CHAIN"

    def test_chain_with_none_serialized(self) -> None:
        assert get_observation_type("on_chain_start", None) == "CHAIN"

    def test_unknown_returns_span(self) -> None:
        assert get_observation_type("on_custom") == "SPAN"


class TestIsAgent:
    def test_known_agent_names(self) -> None:
        for name in ("AgentExecutor", "OpenAIAgent", "StructuredChatAgent"):
            assert _is_agent({"name": name}) is True

    def test_non_agent_name(self) -> None:
        assert _is_agent({"name": "LLMChain"}) is False

    def test_module_prefix(self) -> None:
        assert _is_agent({"module": "langchain.agents.executor"}) is True

    def test_non_agent_module(self) -> None:
        assert _is_agent({"module": "langchain.chains.llm"}) is False

    def test_klass_match(self) -> None:
        assert _is_agent({"klass": "langchain.agents.AgentExecutor"}) is True

    def test_none(self) -> None:
        assert _is_agent(None) is False

    def test_empty_dict(self) -> None:
        assert _is_agent({}) is False


class TestExtractModelName:
    def test_name_field(self) -> None:
        assert extract_model_name({"name": "ChatOpenAI"}) == "ChatOpenAI"

    def test_kwargs_model_field(self) -> None:
        serialized: dict[str, object] = {"kwargs": {"model": "gpt-4o-mini"}}
        assert extract_model_name(serialized) == "gpt-4o-mini"

    def test_kwargs_model_name_field(self) -> None:
        serialized: dict[str, object] = {"kwargs": {"model_name": "gpt-3.5-turbo"}}
        assert extract_model_name(serialized) == "gpt-3.5-turbo"

    def test_none(self) -> None:
        assert extract_model_name(None) == "unknown"

    def test_empty(self) -> None:
        assert extract_model_name({}) == "unknown"


class TestExtractName:
    def test_with_name(self) -> None:
        assert extract_name({"name": "test"}) == "test"

    def test_none(self) -> None:
        assert extract_name(None) is None

    def test_empty(self) -> None:
        assert extract_name({}) is None


class TestFormatOutput:
    def test_none_returns_empty(self) -> None:
        assert format_output(None) == {}

    def test_dict_passthrough(self) -> None:
        assert format_output({"a": 1}) == {"a": 1}

    def test_string_wraps_in_content(self) -> None:
        assert format_output("hello") == {"content": "hello"}


class TestFormatMessagesAsDicts:
    def test_empty_list(self) -> None:
        assert format_messages_as_dicts([]) == []

    def test_dict_passthrough(self) -> None:
        msgs: list[object] = [{"role": "user", "content": "hi"}]
        assert format_messages_as_dicts(msgs) == [{"role": "user", "content": "hi"}]
