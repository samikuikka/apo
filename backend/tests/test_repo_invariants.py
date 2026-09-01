# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportImplicitStringConcatenation=false
"""Repo-wide invariants that encode apo's documented rules as executable checks.

These run as part of the normal backend suite, so every PR is gated on them
without anyone remembering to run anything locally. Two of the checks are
ratchets: the codebase carries known debt (the baseline constants below), and
the tests fail only when that debt grows. When you fix some of the debt,
lower the baseline in the same commit to lock in the improvement.
"""

import ast
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ROUTES_DIR = Path(__file__).resolve().parents[1] / "apo" / "routes"

# Ratchets — lower after cleanup, never raise.
MISSING_ROUTE_DOCSTRINGS_ALLOWED = 42
# Measured on the tree that includes the in-flight react-doctor cleanup;
# plain main carries fewer. Cleanup PRs should drive this toward zero.
SPEC_REFS_IN_TRACKED_FILES_ALLOWED = 78

# Assembled from fragments so this file never matches its own scan.
_SPEC_REF = re.compile("SPE" + "C-[0-9]{2,4}")

_METHOD_ATTRS = {
    ".get": "GET",
    ".post": "POST",
    ".put": "PUT",
    ".delete": "DELETE",
    ".patch": "PATCH",
}

# Directories that never count as tracked sources (mirrors .gitignore for the
# cases where git itself is unavailable, e.g. secondary jj workspaces).
_SKIPPED_DIRS = {
    ".git",
    ".jj",
    ".worktrees",
    ".personal",
    ".venv",
    "node_modules",
    "specs",
    "data",
    "__pycache__",
}


@dataclass
class _RouteRegistration:
    """One @router.get(...)-style decorator, in file declaration order."""

    router: str
    methods: set[str]
    path: str
    has_path_param: bool
    location: str


def _candidate_files() -> list[Path]:
    """Track git when possible; fall back to a filtered tree walk."""
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
        files = [REPO_ROOT / line for line in result.stdout.splitlines() if line]
    except (subprocess.CalledProcessError, OSError):
        files = []
        for directory, subdirectories, names in os.walk(REPO_ROOT):
            subdirectories[:] = [
                entry
                for entry in subdirectories
                if entry not in _SKIPPED_DIRS and not entry.startswith(".uv")
            ]
            files.extend(
                Path(directory) / name
                for name in names
                if not name.endswith((".pyc", ".pyo"))
            )
    return [path for path in files if path.is_file()]


def _decorator_route(decorator: ast.expr) -> tuple[str, str, set[str]] | None:
    """Return (router name, path, HTTP methods) for a route decorator, else None."""
    if not isinstance(decorator, ast.Call):
        return None
    func = decorator.func
    if not isinstance(func, ast.Attribute):
        return None
    attr = f".{func.attr}"
    if attr in _METHOD_ATTRS:
        methods = {_METHOD_ATTRS[attr]}
    elif attr == ".api_route":
        methods = set()
        for keyword in decorator.keywords:
            if keyword.arg == "methods":
                for element in (
                    keyword.value.elts
                    if isinstance(keyword.value, (ast.List, ast.Tuple))
                    else []
                ):
                    if isinstance(element, ast.Constant) and isinstance(
                        element.value, str
                    ):
                        methods.add(element.value.upper())
    else:
        return None
    if not isinstance(func.value, ast.Name):
        return None

    path: str | None = None
    if decorator.args and isinstance(decorator.args[0], ast.Constant):
        arg_value = decorator.args[0].value
        if isinstance(arg_value, str):
            path = arg_value
    for keyword in decorator.keywords:
        if (
            keyword.arg == "path"
            and isinstance(keyword.value, ast.Constant)
            and isinstance(keyword.value.value, str)
        ):
            path = keyword.value.value
    if not isinstance(path, str):
        return None
    return func.value.id, path, methods


def _route_registrations(tree: ast.Module, file_name: str) -> list[_RouteRegistration]:
    routes: list[_RouteRegistration] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            parsed = _decorator_route(decorator)
            if parsed is None:
                continue
            router, path, methods = parsed
            has_path_param = any(
                segment.startswith("{") and segment.rstrip("}").endswith(":path")
                for segment in path.strip("/").split("/")
            )
            routes.append(
                _RouteRegistration(router, methods, path, has_path_param, file_name)
            )
    return routes


def _route_functions(tree: ast.Module) -> list[ast.FunctionDef | ast.AsyncFunctionDef]:
    handlers = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(
            _decorator_route(decorator) is not None
            for decorator in node.decorator_list
        ):
            handlers.append(node)
    return handlers


def test_route_handlers_have_docstrings() -> None:
    """FastAPI renders handler docstrings in Swagger; new endpoints must have one."""
    missing: list[str] = []
    for path in sorted(ROUTES_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        missing.extend(
            f"{path.relative_to(ROUTES_DIR)}:{node.name}"
            for node in _route_functions(tree)
            if not ast.get_docstring(node)
        )
    assert len(missing) <= MISSING_ROUTE_DOCSTRINGS_ALLOWED, (
        f"Route handlers without docstrings grew to {len(missing)} "
        f"(baseline {MISSING_ROUTE_DOCSTRINGS_ALLOWED}). Docstrings are how "
        "endpoints get documented in Swagger UI. Offenders:\n"
        + "\n".join(missing)
    )


def test_no_new_spec_refs_in_tracked_files() -> None:
    """SPEC-NNN refs read as dead ends to public readers; tracked files must not gain any."""
    offenders: dict[str, int] = {}
    total = 0
    for path in _candidate_files():
        relative = path.relative_to(REPO_ROOT)
        if relative.parts[0] == "specs" or path == Path(__file__):
            continue
        count = len(
            _SPEC_REF.findall(path.read_text(encoding="utf-8", errors="replace"))
        )
        if count:
            offenders[str(relative)] = count
            total += count
    assert total <= SPEC_REFS_IN_TRACKED_FILES_ALLOWED, (
        f"SPEC-NNN references in tracked files grew to {total} "
        f"(baseline {SPEC_REFS_IN_TRACKED_FILES_ALLOWED}). Spec identifiers are "
        "maintainer-local; rewrite the reference so it stands alone (see AGENTS.md "
        "'Comments Are Self-Contained'). Offenders:\n"
        + "\n".join(f"{name} ({count})" for name, count in sorted(offenders.items()))
    )


def _path_regex(route_path: str) -> re.Pattern[str]:
    """Convert a FastAPI path to the regex Starlette matches it with."""
    segments = [
        ".+"
        if segment.startswith("{") and segment.rstrip("}").endswith(":path")
        else "[^/]+"
        if segment.startswith("{")
        else re.escape(segment)
        for segment in route_path.strip("/").split("/")
    ]
    return re.compile("^/" + "/".join(segments) + "$")


def _sample_path(route_path: str) -> str:
    """Instantiate a path with deterministic placeholder values for shadow tests."""
    segments = []
    counter = 0
    for segment in route_path.strip("/").split("/"):
        if segment.startswith("{"):
            if segment.rstrip("}").endswith(":path"):
                segments.append(f"multi{counter}/seg{counter}")
            else:
                segments.append(f"seg{counter}")
            counter += 1
        else:
            segments.append(segment)
    return "/" + "/".join(segments)


def test_catchall_path_routes_do_not_shadow_later_routes() -> None:
    """FastAPI matches routes in declaration order — a catch-all swallows later siblings.

    Encodes the AGENTS.md rule "Catch-All Routes Are Terminal": a route using
    `{value:path}` must not be declared before another route on the same router
    whose requests the catch-all can also match.
    """
    violations: list[str] = []
    for path in sorted(ROUTES_DIR.rglob("*.py")):
        routes = _route_registrations(
            ast.parse(path.read_text(encoding="utf-8")), path.name
        )
        for index, earlier in enumerate(routes):
            if not earlier.has_path_param:
                continue
            pattern = _path_regex(earlier.path)
            for later in routes[index + 1 :]:
                if later.router != earlier.router:
                    continue
                if earlier.methods and later.methods and not (
                    earlier.methods & later.methods
                ):
                    continue
                if pattern.fullmatch(_sample_path(later.path)):
                    violations.append(
                        f"{earlier.location}: '{sorted(earlier.methods)} {earlier.path}' "
                        f"shadows later '{sorted(later.methods)} {later.path}' — "
                        "move the catch-all last or narrow its prefix"
                    )
    assert not violations, "\n".join(violations)
