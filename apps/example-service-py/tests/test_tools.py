"""Unit tests for the in-memory tools. No LLM, no backend."""

from app.tools import compute, dispatch, list_files, read_file, search_content


def test_read_file_returns_content_and_line_count() -> None:
    files = {"a.txt": "line one\nline two\nline three"}
    result = read_file({"path": "a.txt"}, files)
    assert result["path"] == "a.txt"
    assert result["content"] == "line one\nline two\nline three"
    assert result["lines"] == 3


def test_read_file_missing_returns_not_found_marker() -> None:
    result = read_file({"path": "missing.txt"}, {})
    assert result["path"] == "missing.txt"
    assert result["content"] == "[File not found: missing.txt]"
    assert result["lines"] == 0


def test_list_files_returns_keys() -> None:
    files = {"a.txt": "x", "b.md": "y"}
    assert sorted(list_files({}, files)["files"]) == ["a.txt", "b.md"]


def test_search_content_is_case_insensitive_regex() -> None:
    files = {"readme.md": "Hello World\nsecond line"}
    result = search_content({"pattern": "WORLD"}, files)
    assert result["total"] == 1
    assert result["matches"][0] == {"file": "readme.md", "line": 1, "text": "Hello World"}


def test_search_content_invalid_regex_returns_empty_with_error() -> None:
    result = search_content({"pattern": "(unclosed"}, {})
    assert result["matches"] == []
    assert result["total"] == 0
    assert "error" in result


def test_compute_supports_basic_arithmetic() -> None:
    assert compute({"expression": "1 + 2 * 3"}, {})["result"] == 7


def test_compute_strips_non_arithmetic_chars() -> None:
    # Letters, underscores and quotes are stripped before eval — only "()" survives,
    # which evals to a harmless empty tuple. Injection cannot run.
    result = compute({"expression": "__import__('os')"}, {})
    assert result["result"] == ()


def test_dispatch_routes_to_named_tool() -> None:
    assert dispatch("list_files", {}, {"x": "y"}) == {"files": ["x"]}


def test_dispatch_unknown_tool_raises() -> None:
    try:
        dispatch("nope", {}, {})
    except KeyError as exc:
        assert "nope" in str(exc)
    else:
        raise AssertionError("expected KeyError")
