"""Shape test for handle_chat with a mocked OpenAI client. No real LLM call.

Tracing is now auto-instrumented by opentelemetry-instrumentation-openai-v2 and
emits spans via the OTel SDK. Because we mock the OpenAI client at the
``_get_client`` boundary, the instrumented ``chat.completions.create`` is never
called, so no spans are emitted during tests — no OTel setup needed.
"""

from typing import Any
from unittest.mock import MagicMock

import pytest

import app.agent as agent_module
from app.agent import handle_chat


class _FunctionCall:
    def __init__(self, name: str, arguments: str) -> None:
        self.name = name
        self.arguments = arguments


class _ToolCall:
    def __init__(self, tool_id: str, name: str, arguments: str) -> None:
        self.id = tool_id
        self.type = "function"
        self.function = _FunctionCall(name, arguments)


class _Message:
    def __init__(self, *, content: str | None, tool_calls: list[_ToolCall] | None = None) -> None:
        self.content = content
        self.tool_calls = tool_calls


class _Choice:
    def __init__(self, message: _Message) -> None:
        self.message = message


class _Usage:
    def __init__(self, prompt: int, completion: int) -> None:
        self.prompt_tokens = prompt
        self.completion_tokens = completion


class _Completion:
    def __init__(self, message: _Message, usage: _Usage) -> None:
        self.choices = [_Choice(message)]
        self.usage = usage


def test_handle_chat_single_turn_no_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_client = MagicMock()
    fake_client.chat.completions.create.return_value = _Completion(
        _Message(content="Hello there"), _Usage(10, 2)
    )
    monkeypatch.setattr(agent_module, "_get_client", lambda: fake_client)
    monkeypatch.setattr(agent_module, "_get_model", lambda: "test-model")

    result = handle_chat({"messages": [{"role": "user", "content": "hi"}]})

    assert result["response"] == "Hello there"
    assert result["tool_calls"] == []
    assert result["usage"] == {"input_tokens": 10, "output_tokens": 2}


def test_handle_chat_executes_tool_then_responds(monkeypatch: pytest.MonkeyPatch) -> None:
    list_call = _ToolCall("call-1", "list_files", "{}")
    step0_msg = _Message(content=None, tool_calls=[list_call])
    step1_msg = _Message(content="Found one file: a.txt")

    fake_client = MagicMock()
    fake_client.chat.completions.create.side_effect = [
        _Completion(step0_msg, _Usage(10, 2)),
        _Completion(step1_msg, _Usage(11, 3)),
    ]
    monkeypatch.setattr(agent_module, "_get_client", lambda: fake_client)
    monkeypatch.setattr(agent_module, "_get_model", lambda: "test-model")

    result = handle_chat(
        {"messages": [{"role": "user", "content": "what files?"}], "files": {"a.txt": "x"}}
    )

    assert result["response"] == "Found one file: a.txt"
    assert result["tool_calls"] == [{"tool": "list_files", "args": {}, "result": {"files": ["a.txt"]}}]
    assert result["usage"]["input_tokens"] == 10 + 11
    assert result["usage"]["output_tokens"] == 2 + 3


def test_handle_chat_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
        handle_chat({"messages": [{"role": "user", "content": "hi"}]})
