"""In-memory tools the agent can call.

Mirrors the four tools in ``apps/example-service/app/lib/agent/service.ts``:
``read_file``, ``list_files``, ``search_content``, ``compute``. All operate on
a ``files: dict[str, str]`` mapping passed in per request — no filesystem
access, no state.
"""

from __future__ import annotations

import re
from typing import Any

type Files = dict[str, str]
type JsonArgs = dict[str, Any]


def read_file(args: JsonArgs, files: Files) -> dict[str, Any]:
    path = args.get("path", "")
    content = files.get(path)
    if content is None:
        return {"path": path, "content": f"[File not found: {path}]", "lines": 0}
    return {"path": path, "content": content, "lines": content.count("\n") + 1}


def list_files(_: JsonArgs, files: Files) -> dict[str, Any]:
    return {"files": list(files.keys())}


def search_content(args: JsonArgs, files: Files) -> dict[str, Any]:
    pattern = args.get("pattern", "")
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        return {"matches": [], "total": 0, "error": f"invalid regex: {pattern}"}

    matches: list[dict[str, Any]] = []
    for fpath, content in files.items():
        for index, line in enumerate(content.split("\n"), start=1):
            if regex.search(line):
                matches.append({"file": fpath, "line": index, "text": line.strip()})
    return {"matches": matches, "total": len(matches)}


def compute(args: JsonArgs, _: Files) -> dict[str, Any]:
    expression = args.get("expression", "")
    # Mirror service.ts: strip everything except digits, operators, parens, whitespace.
    sanitized = re.sub(r"[^0-9+\-*/().%\s]", "", expression)
    try:
        # eval is restricted to the sanitized subset; only arithmetic chars remain.
        result: float | str = eval(sanitized, {"__builtins__": {}}, {})  # noqa: S307
    except Exception:
        result = "error: could not evaluate"
    return {"expression": expression, "result": result}


# --- dispatch table ----------------------------------------------------------

TOOLS: dict[str, Any] = {
    "read_file": read_file,
    "list_files": list_files,
    "search_content": search_content,
    "compute": compute,
}


def dispatch(name: str, args: JsonArgs, files: Files) -> dict[str, Any]:
    """Run a tool by name. Raises ``KeyError`` for unknown tools."""
    handler = TOOLS.get(name)
    if handler is None:
        raise KeyError(f"unknown tool: {name}")
    return handler(args, files)


# --- OpenAI tool schemas (function-calling format) ---------------------------

OPENAI_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file by its exact path as shown by list_files.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List all available files.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_content",
            "description": "Search all files for a text pattern (case-insensitive regex).",
            "parameters": {
                "type": "object",
                "properties": {"pattern": {"type": "string"}},
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "compute",
            "description": "Evaluate a mathematical expression (digits, + - * / % and parentheses only).",
            "parameters": {
                "type": "object",
                "properties": {"expression": {"type": "string"}},
                "required": ["expression"],
            },
        },
    },
]
