# pyright: reportAny=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
import os
import tempfile
from typing import Protocol, cast, final, runtime_checkable

from fastapi import HTTPException

from apo.routes.agent_task_files import list_task_files, read_task_file

JsonPrimitive = str | int | float | bool | None
JsonValue = JsonPrimitive | dict[str, "JsonValue"] | list["JsonValue"]


@runtime_checkable
class _HasModelDump(Protocol):
    def model_dump(self, *, mode: str) -> JsonValue: ...


def _create_task_folder(
    root: str, task_id: str, extra_files: dict[str, str] | None = None
) -> str:
    task_dir = os.path.join(root, task_id)
    os.makedirs(task_dir, exist_ok=True)

    # The task file is `<task_id>.eval.ts` — the convention discovery actually
    # scans for. Uses the real API (task(...)/test(...)), not the retired
    # `defineTask`/`task.ts` shape.
    with open(os.path.join(task_dir, f"{task_id}.eval.ts"), "w") as f:
        f.write('import { task, test } from "@apo/sdk/agent-task";\n')
        f.write(
            f'task("{task_id}", {{ adapter: "test-adapter" }});\n'
        )
        f.write(
            f'const check = test;\n'
            f'check("smoke", (t) => t.noFailedActions());\n'
        )

    if extra_files:
        for name, content in extra_files.items():
            filepath = os.path.join(task_dir, name)
            os.makedirs(os.path.dirname(filepath), exist_ok=True)
            with open(filepath, "w") as f:
                f.write(content)

    return task_dir


@contextmanager
def _client_with_task_root(task_root: str):
    yield _AgentTaskFilesClient(task_root)


@dataclass
class _DirectResponse:
    status_code: int
    payload: JsonValue

    def json(self) -> JsonValue:
        return self.payload


@final
class _AgentTaskFilesClient:
    def __init__(self, task_root: str):
        self._task_root = task_root

    def get(self, url: str) -> _DirectResponse:
        try:
            payload = self._call(url)
        except HTTPException as exc:
            return _DirectResponse(exc.status_code, {"detail": _to_jsonable(exc.detail)})
        return _DirectResponse(200, _to_jsonable(payload))

    def _call(self, url: str) -> object:
        prefix = "/v1/agent-tasks/"
        if not url.startswith(prefix):
            raise AssertionError(f"Unhandled url: {url}")

        path_with_query = url[len(prefix) :]
        path, _, _query = path_with_query.partition("?")

        marker = "/files/"
        if marker in path:
            task_id, file_path = path.split(marker, 1)
            return asyncio.run(read_task_file(task_id, file_path, self._task_root, None))

        if path.endswith("/files"):
            task_id = path[: -len("/files")]
            return asyncio.run(list_task_files(task_id, self._task_root, None))

        raise AssertionError(f"Unhandled url: {url}")


def _to_jsonable(value: object) -> JsonValue:
    if isinstance(value, _HasModelDump):
        return value.model_dump(mode="json")
    if isinstance(value, list):
        return [_to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    return cast(JsonPrimitive, value)


def _json_object(value: JsonValue) -> dict[str, JsonValue]:
    assert isinstance(value, dict)
    return value


def _json_list(value: JsonValue) -> list[JsonValue]:
    assert isinstance(value, list)
    return value


def _file_entries(data: dict[str, JsonValue]) -> list[dict[str, JsonValue]]:
    return [_json_object(item) for item in _json_list(data["files"])]


def _detail_text(response: _DirectResponse) -> str:
    return str(_json_object(response.json())["detail"]).lower()


def test_list_files_returns_all_task_files():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "my-task",
            {
                "checks.ts": "export function check() {}",
                "files/instructions.md": "# Instructions\nDo the thing.",
                "files/data.txt": "some data here",
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/my-task/files?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())
        assert data["task_id"] == "my-task"
        assert data["task_path"] == os.path.join(tmp, "my-task")

        paths = [entry["path"] for entry in _file_entries(data)]
        assert "my-task.eval.ts" in paths
        assert "checks.ts" in paths
        assert "files" in paths
        assert "files/instructions.md" in paths
        assert "files/data.txt" in paths


def test_list_files_sorts_directories_first():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "sorted-task",
            {
                "a_file.ts": "// a",
                "z_dir/nested.txt": "nested",
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/sorted-task/files?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())
        types = [entry["type"] for entry in _file_entries(data)]
        last_dir_idx = 0
        for i, entry_type in enumerate(types):
            if entry_type == "directory":
                last_dir_idx = i
        first_file_idx = next(i for i, entry_type in enumerate(types) if entry_type == "file")
        assert last_dir_idx < first_file_idx


def test_list_files_skips_hidden_and_ignored():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = os.path.join(tmp, "hidden-task")
        os.makedirs(task_dir)
        with open(os.path.join(task_dir, "hidden-task.eval.ts"), "w") as f:
            f.write('import { task } from "@apo/sdk/agent-task";\ntask("hidden-task", { adapter: "a" });')
        with open(os.path.join(task_dir, ".hidden"), "w") as f:
            f.write("hidden")
        os.makedirs(os.path.join(task_dir, "node_modules"))
        with open(os.path.join(task_dir, "node_modules", "pkg.js"), "w") as f:
            f.write("pkg")
        os.makedirs(os.path.join(task_dir, "__pycache__"))
        with open(os.path.join(task_dir, "__pycache__", "cache.pyc"), "w") as f:
            f.write("cache")

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/hidden-task/files?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())
        paths = [entry["path"] for entry in _file_entries(data)]
        assert ".hidden" not in paths
        assert "node_modules" not in paths
        assert "__pycache__" not in paths


def test_list_files_nonexistent_task_returns_404():
    with tempfile.TemporaryDirectory() as tmp:
        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/no-such-task/files?task_root={tmp}")
        assert response.status_code == 404
        assert "not found" in _detail_text(response)


def test_read_file_returns_content():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "read-task",
            {
                "checks.ts": "export function check() { return true; }\n",
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/read-task/files/checks.ts?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())
        assert data["name"] == "checks.ts"
        assert data["path"] == "checks.ts"
        assert "export function check" in str(data["content"])
        assert data["language"] == "typescript"
        assert cast(int, data["lines"]) >= 1
        assert cast(int, data["size_bytes"]) > 0


def test_read_file_in_subdirectory():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "sub-task",
            {
                "files/instructions.md": "# Title\nDo the thing.\n",
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(
                f"/v1/agent-tasks/sub-task/files/files/instructions.md?task_root={tmp}"
            )

        assert response.status_code == 200
        data = _json_object(response.json())
        assert data["name"] == "instructions.md"
        assert data["path"] == "files/instructions.md"
        assert data["language"] == "markdown"
        assert "# Title" in str(data["content"])


def test_read_file_language_detection():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "lang-task",
            {
                "script.py": "def hello():\n    pass\n",
                "data.json": '{"key": "value"}\n',
                "notes.txt": "some notes\n",
                "changes.diff": "--- a/file\n+++ b/file\n+added\n",
                "patch.patch": "--- a/file\n+++ b/file\n-removed\n",
            },
        )

        with _client_with_task_root(tmp) as client:
            cases = [
                ("script.py", "python"),
                ("data.json", "json"),
                ("notes.txt", "text"),
                ("changes.diff", "diff"),
                ("patch.patch", "diff"),
            ]
            for filename, expected_lang in cases:
                response = client.get(
                    f"/v1/agent-tasks/lang-task/files/{filename}?task_root={tmp}"
                )
                assert response.status_code == 200, f"Failed for {filename}"
                data = _json_object(response.json())
                assert data["language"] == expected_lang, f"Wrong language for {filename}"


def test_read_file_path_traversal_via_symlink_blocked():
    with tempfile.TemporaryDirectory() as tmp:
        task_dir = _create_task_folder(tmp, "safe-task")

        outside_dir = os.path.join(tmp, "outside")
        os.makedirs(outside_dir)
        secret_file = os.path.join(outside_dir, "secret.txt")
        with open(secret_file, "w") as f:
            f.write("secret data")

        link_path = os.path.join(task_dir, "escape")
        os.symlink(outside_dir, link_path)

        with _client_with_task_root(tmp) as client:
            response = client.get(
                f"/v1/agent-tasks/safe-task/files/escape/secret.txt?task_root={tmp}"
            )
        assert response.status_code == 403
        assert "access denied" in _detail_text(response)


def test_read_file_nonexistent_returns_404():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(tmp, "exist-task")

        with _client_with_task_root(tmp) as client:
            response = client.get(
                f"/v1/agent-tasks/exist-task/files/nonexistent.ts?task_root={tmp}"
            )
        assert response.status_code == 404


def test_read_file_directory_returns_400():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "dir-task",
            {
                "files/sample.txt": "data",
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/dir-task/files/files?task_root={tmp}")
        assert response.status_code == 400
        assert "directory" in _detail_text(response)


def test_read_file_nonexistent_task_returns_404():
    with tempfile.TemporaryDirectory() as tmp:
        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/no-task/files/anything?task_root={tmp}")
        assert response.status_code == 404


def test_read_file_eval_ts():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(tmp, "main-task")

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/main-task/files/main-task.eval.ts?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())
        assert data["name"] == "main-task.eval.ts"
        assert data["language"] == "typescript"
        assert "task(" in str(data["content"])


def test_read_file_with_unicode_content():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "unicode-task",
            {
                "unicode.ts": '// Hello 世界 🌍\nconst msg = "Héllo wörld";\n',
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(
                f"/v1/agent-tasks/unicode-task/files/unicode.ts?task_root={tmp}"
            )

        assert response.status_code == 200
        data = _json_object(response.json())
        assert "世界" in str(data["content"])
        assert "🌍" in str(data["content"])


def test_list_files_task_with_only_task_ts():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(tmp, "minimal-task")

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/minimal-task/files?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())
        paths = [entry["path"] for entry in _file_entries(data)]
        assert paths == ["minimal-task.eval.ts"]


def test_read_file_size_limit():
    with tempfile.TemporaryDirectory() as tmp:
        big_content = "x" * 1_000_001
        _create_task_folder(
            tmp,
            "big-task",
            {
                "big.txt": big_content,
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/big-task/files/big.txt?task_root={tmp}")
        assert response.status_code == 413


def test_list_files_includes_file_metadata():
    with tempfile.TemporaryDirectory() as tmp:
        _create_task_folder(
            tmp,
            "meta-task",
            {
                "checks.ts": "export {}",
            },
        )

        with _client_with_task_root(tmp) as client:
            response = client.get(f"/v1/agent-tasks/meta-task/files?task_root={tmp}")

        assert response.status_code == 200
        data = _json_object(response.json())

        checks_entry = next(entry for entry in _file_entries(data) if entry["path"] == "checks.ts")
        assert checks_entry["type"] == "file"
        assert checks_entry["extension"] == ".ts"
        assert checks_entry["size_bytes"] is not None
        assert cast(int, checks_entry["size_bytes"]) > 0

        task_entry = next(entry for entry in _file_entries(data) if entry["path"] == "meta-task.eval.ts")
        assert task_entry["extension"] == ".ts"
