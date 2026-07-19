"""OpenInference / LangChain mapper (priority 2).

Handles ``openinference.span.kind`` attributes from Arize Phoenix / LangChain.
"""

from __future__ import annotations

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
MAPPER_VERSION = 1


def try_map(attrs: dict[str, Any], span_name: str) -> str | None:
    """Return observation_type if openinference.span.kind is recognized."""
    oi_kind = get_str(attrs, "openinference.span.kind")
    if oi_kind:
        return _OI_KIND_MAP.get(oi_kind.upper())
    return None
