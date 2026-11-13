"""OpenInference / LangChain mapper (priority 2).

Handles ``openinference.span.kind`` attributes from Arize Phoenix / LangChain.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportUnusedParameter=false

from __future__ import annotations

import re
from typing import Any

from ._shared import get_str

_OI_KIND_MAP = {
    "LLM": "GENERATION",
    "CHAT": "GENERATION",
    "TOOL": "TOOL",
    "RETRIEVER": "RETRIEVER",
    "AGENT": "AGENT",
    "CHAIN": "CHAIN",
    "EMBEDDING": "EMBEDDING",
    "RERANKER": "RETRIEVER",
}

MAPPER_NAME = "openinference"
MAPPER_VERSION = 2

_DOCUMENT_FIELD = re.compile(r"^retrieval\.documents\.(\d+)\.(id|score|content)$")


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return observation_type if openinference.span.kind is recognized."""
    oi_kind = get_str(attrs, "openinference.span.kind")
    if oi_kind:
        return _OI_KIND_MAP.get(oi_kind.upper())
    return None


def extract_retrieval(
    attrs: dict[str, Any],
) -> tuple[dict[str, object] | None, dict[str, object] | None]:
    """A retrieval's query and documents as ``(tool_parameters, tool_result)``.

    OpenInference instrumented retrievers (LangChain, LlamaIndex, Phoenix)
    record the query as ``input.value`` and flatten the returned documents as
    ``retrieval.documents.<i>.{id,score,content}``. Mapping them onto the same
    tool channels the apo SDK exports lets retrieval assertions read
    auto-instrumented retrievals with no wrapping. Either side is None when
    the span did not record it.
    """
    query = get_str(attrs, "input.value")
    params: dict[str, object] | None = {"query": query} if query else None

    by_index: dict[int, dict[str, object]] = {}
    for key, value in attrs.items():
        match = _DOCUMENT_FIELD.match(key)
        if match is None:
            continue
        index, field = int(match.group(1)), match.group(2)
        document = by_index.setdefault(index, {})
        if field == "score":
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                document["score"] = value
        elif isinstance(value, str) and value:
            document[field] = value
    documents: list[object] | None = None
    if by_index:
        documents = [by_index[index] for index in sorted(by_index)]
    return params, ({"documents": documents} if documents is not None else None)
