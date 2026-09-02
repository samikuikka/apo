# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportImplicitStringConcatenation=false, reportAny=false
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

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
ROUTES_DIR = Path(__file__).resolve().parents[1] / "apo" / "routes"

# Ratchets, now at zero after the cleanup PR — keep them there.
MISSING_ROUTE_DOCSTRINGS_ALLOWED = 0
# The debt these ratchets guarded was cleaned up; they are strict now.
SPEC_REFS_IN_TRACKED_FILES_ALLOWED = 0

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


# --- CI covers its tests -----------------------------------------------------
#
# A test file that no CI job executes is worse than no test: everyone believes
# the area is covered while nothing ever runs. The census below maps each
# suite-running CI command (the anchor, asserted verbatim against workflow
# run-steps so a deleted step fails this check) to the directory whose test
# files that command executes. Files under those roots are covered unless they
# carry a deliberate exemption; test files anywhere else in the repo are
# unknown to CI and fail the census.

_CI_TEST_INVOCATIONS: dict[str, str] = {
    "uv run pytest -x -q": "backend/tests",
    "uv run pytest -q": "apps/example-service-py/tests",
    "uv run --with pytest pytest -q": "packages/apo-otel-python/tests",
    "uv run --with pytest --with langchain-core pytest -q": "packages/langchain-apo/tests",
    "pnpm --filter @apo-ai/cli test:unit": "packages/cli/tests",
    "pnpm --filter @apo-ai/sdk test": "packages/sdk/tests",
    "pnpm --filter dashboard test": "apps/dashboard/src",
    "pnpm --filter @apo/example-service test:run": "apps/example-service",
}

# Deliberate exclusions, file by file. Growth of this list is a visible diff:
# adding a line is choosing to leave a test outside CI, with the reason written
# down — never an accident.
_TEST_FILE_EXEMPTIONS: dict[str, str] = {
    "backend/apo/services/test_result_corrections.py": (
        "not a test: feature module implementing manual test-result corrections; "
        "exempt so the test_ prefix does not confuse the census"
    ),
    "packages/cli/tests/connect-scene.test.ts": (
        "long scene test, excluded from test:unit by script flag; "
        "run manually: pnpm --filter @apo-ai/cli test"
    ),
    "apps/dashboard/e2e/agent-journey.spec.ts": (
        "Playwright e2e, needs a live stack; not wired into CI yet"
    ),
    "apps/dashboard/e2e/demo-journey.spec.ts": (
        "Playwright e2e, needs a live stack; not wired into CI yet"
    ),
    "apps/dashboard/e2e/hosted-alpha-adopter-journey.spec.ts": (
        "manual hosted-alpha gate: pnpm test:hosted-alpha-journey"
    ),
    "apps/dashboard/e2e/alpha-project-setup-and-run.spec.ts": (
        "manual alpha gate: pnpm test:alpha:ui (root package.json)"
    ),
    "apps/dashboard/e2e/alpha-schedule-lifecycle.spec.ts": (
        "manual alpha gate: pnpm test:alpha:ui (root package.json)"
    ),
    "apps/dashboard/e2e/alpha-trace-drilldown.spec.ts": (
        "manual alpha gate: pnpm test:alpha:ui (root package.json)"
    ),
}

_TEST_FILE_SUFFIXES = (".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")
_TEST_FILE_PREFIX = "test_"


def _workflow_run_step_texts() -> list[str]:
    """All `run:` step texts across every workflow, for anchor matching."""
    texts: list[str] = []
    workflows_dir = REPO_ROOT / ".github" / "workflows"
    for workflow in sorted(workflows_dir.glob("*.y*ml")):
        document = yaml.safe_load(workflow.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            continue
        jobs = document.get("jobs")
        if not isinstance(jobs, dict):
            continue
        for job in jobs.values():
            if not isinstance(job, dict):
                continue
            for step in job.get("steps") or []:
                if isinstance(step, dict) and isinstance(step.get("run"), str):
                    texts.append(step["run"])
    return texts


def _is_test_file(path: Path) -> bool:
    name = path.name
    return name.startswith(_TEST_FILE_PREFIX) and name.endswith(".py") or name.endswith(
        _TEST_FILE_SUFFIXES
    )


def _test_files_under(root: Path) -> list[Path]:
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and _is_test_file(path)
    )


def test_ci_invokes_every_registered_test_suite() -> None:
    """Each anchor command must still appear in some workflow run-step."""
    texts = _workflow_run_step_texts()
    missing = [
        anchor
        for anchor in _CI_TEST_INVOCATIONS
        if not any(anchor in text for text in texts)
    ]
    assert not missing, (
        "CI no longer runs: "
        + "; ".join(missing)
        + ". Restore the workflow step, or retire it and update _CI_TEST_INVOCATIONS "
        "plus _TEST_FILE_EXEMPTIONS in the same commit."
    )


def test_every_test_file_runs_in_ci_or_is_exempt() -> None:
    """No test file may exist that CI neither runs nor explicitly exempts."""
    texts = _workflow_run_step_texts()
    active_root_dirs = [
        root_dir
        for anchor, root_dir in _CI_TEST_INVOCATIONS.items()
        if any(anchor in text for text in texts)
    ]
    # Relative "dir/" prefixes whose test files an active CI step executes.
    known_root_prefixes = {f"{root_dir}/" for root_dir in active_root_dirs}

    problems: list[str] = []

    for root_dir in active_root_dirs:
        root = REPO_ROOT / root_dir
        if not root.exists():
            problems.append(f"registered CI test root missing: {root_dir}")
            continue
        for test_file in _test_files_under(root):
            relative = test_file.relative_to(REPO_ROOT).as_posix()
            if relative not in _TEST_FILE_EXEMPTIONS:
                continue  # an active CI step runs this root's files: covered

    # Test files living outside every registered root are unknown to CI.
    for directory, subdirectories, names in os.walk(REPO_ROOT):
        subdirectories[:] = [
            entry
            for entry in subdirectories
            if entry not in _SKIPPED_DIRS and not entry.startswith(".uv")
        ]
        for name in names:
            candidate = Path(directory) / name
            if not _is_test_file(candidate):
                continue
            relative = candidate.relative_to(REPO_ROOT).as_posix()
            if relative in _TEST_FILE_EXEMPTIONS:
                continue
            if any(relative.startswith(prefix) for prefix in known_root_prefixes):
                continue
            problems.append(
                f"test file no CI rule knows about: {relative} — add a CI step "
                "or an exemption with a reason"
            )

    assert not problems, "\n".join(problems)
