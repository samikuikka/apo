from __future__ import annotations

from typing import Any

AGENT_CLASS_NAMES = frozenset({
    "AgentExecutor",
    "PlanAndExecute",
    "ReActAgent",
    "OpenAIAgent",
    "StructuredChatAgent",
    "ChatConversationalReactionAgent",
    "ConversationalAgent",
    "ZeroShotAgent",
    "MRKLAgent",
})

AGENT_MODULE_PREFIXES = frozenset({
    "langchain.agents",
    "langchain_core.agents",
    "langchain_community.agents",
})


def get_observation_type(
    event_name: str,
    serialized: dict[str, object] | None = None,
) -> str:
    if event_name == "on_chat_model_start":
        return "GENERATION"
    if event_name == "on_tool_start":
        return "TOOL"
    if event_name == "on_retriever_start":
        return "RETRIEVER"
    if event_name in ("on_chain_start",):
        if _is_agent(serialized):
            return "AGENT"
        return "CHAIN"
    return "SPAN"


def _is_agent(serialized: dict[str, object] | None) -> bool:
    if serialized is None:
        return False

    name = serialized.get("name")
    if isinstance(name, str) and name in AGENT_CLASS_NAMES:
        return True

    module = serialized.get("module")
    if isinstance(module, str):
        for prefix in AGENT_MODULE_PREFIXES:
            if module.startswith(prefix):
                return True

    klass = serialized.get("klass")
    if isinstance(klass, str):
        for agent_name in AGENT_CLASS_NAMES:
            if agent_name in klass:
                return True

    return False


def extract_model_name(serialized: dict[str, object] | None) -> str:
    if serialized is None:
        return "unknown"

    kwargs = serialized.get("kwargs")
    if isinstance(kwargs, dict):
        model_val = kwargs.get("model_name") or kwargs.get("model")
        if isinstance(model_val, str):
            return model_val

    name = serialized.get("name")
    if isinstance(name, str):
        return name

    return "unknown"


def extract_name(serialized: dict[str, object] | None) -> str | None:
    if serialized is None:
        return None

    name = serialized.get("name")
    if isinstance(name, str):
        return name

    return None


def format_messages_as_dicts(
    messages: list[Any] | list[list[Any]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    flat: list[Any]
    if messages and isinstance(messages[0], list):
        flat = messages[0]
    else:
        flat = messages

    for msg in flat:
        if hasattr(msg, "to_messages"):
            continue
        if hasattr(msg, "content"):
            result.append({
                "role": getattr(msg, "type", type(msg).__name__),
                "content": msg.content,
            })
        elif isinstance(msg, dict):
            result.append(msg)
    return result


def format_output(output: Any) -> dict[str, Any]:
    if output is None:
        return {}
    if isinstance(output, dict):
        return output
    if hasattr(output, "content"):
        return {"content": output.content}
    if hasattr(output, "to_messages"):
        messages = output.to_messages()
        return {
            "messages": [
                {"role": getattr(m, "type", type(m).__name__), "content": m.content}
                for m in messages
            ]
        }
    if isinstance(output, str):
        return {"content": output}
    if isinstance(output, list):
        items: list[Any] = []
        for item in output:
            if hasattr(item, "page_content"):
                items.append({
                    "page_content": item.page_content,
                    "metadata": getattr(item, "metadata", {}),
                })
            else:
                items.append(str(item))
        return {"documents": items}
    return {"content": str(output)}


def extract_token_usage(
    response: Any,
) -> dict[str, int | None]:
    usage: dict[str, int | None] = {
        "prompt_tokens": None,
        "completion_tokens": None,
    }

    llm_output = getattr(response, "llm_output", None)
    if isinstance(llm_output, dict):
        token_usage = llm_output.get("token_usage")
        if isinstance(token_usage, dict):
            usage["prompt_tokens"] = token_usage.get("prompt_tokens")
            usage["completion_tokens"] = token_usage.get("completion_tokens")

    generations = getattr(response, "generations", None)
    if generations:
        for gen_list in generations:
            for gen in gen_list:
                gen_info = getattr(gen, "generation_info", None)
                if isinstance(gen_info, dict):
                    tu = gen_info.get("usage")
                    if isinstance(tu, dict):
                        if usage["prompt_tokens"] is None:
                            usage["prompt_tokens"] = tu.get("prompt_tokens")
                        if usage["completion_tokens"] is None:
                            usage["completion_tokens"] = tu.get("completion_tokens")

    usage_metadata = getattr(response, "usage_metadata", None)
    if isinstance(usage_metadata, dict):
        if usage["prompt_tokens"] is None:
            usage["prompt_tokens"] = usage_metadata.get("input_tokens")
        if usage["completion_tokens"] is None:
            usage["completion_tokens"] = usage_metadata.get("output_tokens")

    return usage
