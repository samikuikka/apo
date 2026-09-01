import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { listTaskCandidateDirs, type ScanOptions } from "./scanner.ts";
// execution property retired

export type TaskMeta = {
  /**
   * The task's globally-unique id: the declared task name scoped by its
   * folder path relative to the task root (e.g. `chat/cost-inquiry`). A
   * task at the root keeps its bare name. This **must** mirror
   * `backend/apo/services/agent_task_discovery.py` so the CLI and the
   * backend inventory key tasks by the same id — otherwise `task run`
   * sends an id the backend can't match (issue #12).
   */
  id: string;
  /** The folder path relative to the task root (empty when at the root). */
  folderPath: string;
  adapter: string;
  hasChecks: boolean;
  path: string;
  /** The canonical eval filename (e.g. `code-review.eval.ts`). */
  evalFileName: string;
  deliverables: string[];
  files: string[];
  /**
   * First line of the task's declared `description`, read statically from
   * the `.eval.ts` (the key and its string may sit on different lines).
   * `null` when the task declares none — human-facing pickers show nothing
   * rather than filler.
   */
  description: string | null;
  /**
   * How many inline `test(`/`check(` calls the eval declares — the honest
   * "how thoroughly will this run be judged" number. 0 with `hasChecks`
   * true means checks live in a legacy `checks.ts` the scanner can't count.
   */
  checkCount: number;
  /**
   * The task's declared execution preference, read statically
   * from the `.eval.ts` file. `undefined` when absent or `"auto"` — both
   * mean "no preference, defer to project default / reachability". Read
   * without loading the task module so we don't pay for double registration
   * of checks at dispatch time.
   */
};

export type DiscoverOptions = Omit<ScanOptions, "rootDir">;

export function discoverTaskMeta(
  rootDir: string,
  options?: DiscoverOptions,
): TaskMeta[] {
  const candidates = listTaskCandidateDirs({ rootDir, ...options });
  const results: TaskMeta[] = [];

  for (const taskDir of candidates) {
    const meta = parseTaskMeta(taskDir, rootDir);
    if (meta) {
      results.push(meta);
    }
  }

  return results;
}

/**
 * Resolve a task id against the discovered tree.
 *
 * Ids are folder-scoped (see `TaskMeta.id`), so callers normally pass the
 * full id (`chat/cost-inquiry`). As a convenience, a **bare name** (`cost-inquiry`)
 * resolves when it's unique — matching the last segment of exactly one task's
 * id. When two or more tasks share that bare name, the ref is ambiguous: this
 * prints a hint listing the full ids to use and returns `undefined` (mirrors
 * the backend's inventory-keying rule and issue #12's UX).
 */
export function findTaskMetaById(
  rootDir: string,
  taskId: string,
): TaskMeta | undefined {
  const tasks = discoverTaskMeta(rootDir);
  return resolveTaskRef(tasks, taskId);
}

/**
 * Match a ref against an already-discovered task list. Exported so callers
 * that resolve many refs from one discovery pass (e.g. `batch create`) can
 * avoid re-scanning. Same resolution rule as `findTaskMetaById`: exact
 * folder-scoped id first, then a bare-name fallback that resolves only when
 * unique.
 */
export function resolveTaskRef(
  tasks: TaskMeta[],
  ref: string,
): TaskMeta | undefined {
  const exact = tasks.find((t) => t.id === ref);
  if (exact) return exact;

  const matches = tasks.filter((t) => bareTaskName(t.id) === ref);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const ids = matches.map((t) => t.id).sort().join(", ");
    console.error(`Ambiguous task '${ref}' matches: ${ids}. Pass the full id.`);
  }
  return undefined;
}

/** The bare name (last segment) of a folder-scoped id. */
export function bareTaskName(folderScopedId: string): string {
  const slash = folderScopedId.lastIndexOf("/");
  return slash < 0 ? folderScopedId : folderScopedId.slice(slash + 1);
}

function parseTaskMeta(taskDir: string, rootDir: string): TaskMeta | undefined {
  const evalFiles = readdirSync(taskDir).filter((f) => f.endsWith(".eval.ts"));
  if (evalFiles.length === 0) {
    return undefined;
  }
  if (evalFiles.length > 1) {
    return undefined;
  }
  const evalFile = evalFiles[0]!;
  const taskFilePath = join(taskDir, evalFile);

  const content = readFileSync(taskFilePath, "utf-8");
  const bareId = extractTaskId(content);
  if (!bareId) {
    return undefined;
  }

  const adapter = extractAdapter(content) ?? "unknown";

  const deliverables = extractArrayField(content, "deliverables");
  const hasChecks = extractHasChecks(content, taskDir);

  // Folder-scope the id so the CLI and the backend inventory agree on ids
  // (issue #12). Mirrors backend agent_task_discovery._parse_task_file:
  // folder_path is the path *above* the task folder (its parent relative to
  // the root), and the id is "folder_path/bare_name" — NOT including the
  // task's own folder name (which the bare name already covers).
  const relTaskPath = normalizeRelative(relative(rootDir, taskDir));
  const folderPath = parentDir(relTaskPath);
  const id = folderPath ? `${folderPath}/${bareId}` : bareId;

  const filesDir = join(taskDir, "files");
  const files: string[] = [];
  if (existsSync(filesDir) && statSync(filesDir).isDirectory()) {
    for (const f of readdirSync(filesDir)) {
      files.push(f);
    }
  }

  return {
    id,
    folderPath,
    adapter,
    hasChecks,
    path: taskDir,
    evalFileName: evalFile,
    deliverables,
    files,
    description: extractDescription(content),
    checkCount: countInlineChecks(content),
  };
}

/**
 * First line of the task's `description` field, truncated for pickers.
 * The key and the string may sit on different lines (`description:\n  "…"`),
 * so `\s*` bridges the gap — same trick as the other extract* helpers,
 * never loading the module.
 */
function extractDescription(content: string): string | null {
  const match = content.match(/description\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/);
  if (!match) return null;
  const raw = match[1] ?? match[2] ?? match[3] ?? "";
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (firstLine.length > 100) return `${firstLine.slice(0, 99)}…`;
  return firstLine || null;
}

/** Top-level `test(`/`check(` calls — one judged assertion each. */
function countInlineChecks(content: string): number {
  const matches = content.match(/^[ \t]*(?:test|check)\s*\(/gm);
  return matches ? matches.length : 0;
}

/** Normalize a relative path to POSIX separators; empty string for the root. */
function normalizeRelative(rel: string): string {
  const posix = rel.split("\\").join("/");
  if (posix === "." || posix === "") return "";
  return posix;
}

/** POSIX dirname of a relative path; empty for a single segment or the root. */
function parentDir(relPath: string): string {
  if (!relPath) return "";
  const slash = relPath.lastIndexOf("/");
  if (slash < 0) return "";
  return relPath.slice(0, slash);
}

function extractStringField(content: string, field: string): string | null {
  const doubleQuoteRegex = new RegExp(`${field}\\s*:\\s*"([^"]*)"`);
  const match = content.match(doubleQuoteRegex);
  if (match) return match[1];

  const singleQuoteRegex = new RegExp(`${field}\\s*:\\s*'([^']*)'`);
  const match2 = content.match(singleQuoteRegex);
  if (match2) return match2[1];

  return null;
}

function extractTaskId(content: string): string | null {
  // New API: task("name", ...)
  const taskMatch = content.match(/\btask\(\s*["']([^"']+)["']/);
  if (taskMatch) return taskMatch[1];
  // Legacy: id: "name" inside defineTask config
  return extractStringField(content, "id");
}

function extractAdapter(content: string): string | null {
  // New API: adapter: someAdapter (identifier inside config). Capture an
  // optional opening paren so factory calls like `adapter: createXxxAdapter(y)`
  // are shown honestly as `createXxxAdapter(...)` — the scanner can't load the
  // module to resolve the runtime adapter.name, but the parens make it obvious
  // the displayed identifier is a factory, not the adapter itself.
  const adapterProp = content.match(/\badapter\s*:\s*(\w+)(\()?/);
  if (adapterProp) {
    return adapterProp[2] ? `${adapterProp[1]}(...)` : adapterProp[1];
  }
  // Legacy explicit adapter names take precedence over the defineTask variable.
  const adapterName = extractStringField(content, "adapter");
  if (adapterName) return adapterName;
  // Legacy: defineTask(someAdapter, ...)
  const defineTaskMatch = content.match(/defineTask\(\s*(\w+)/);
  if (defineTaskMatch) return defineTaskMatch[1];
  return null;
}

function extractHasChecks(content: string, taskDir: string): boolean {
  // Checks are inline (check( / test( calls in the .eval.ts file itself)
  if (/\bcheck\s*\(|\btest\s*\(/.test(content)) return true;
  // Legacy: separate checks.ts file
  return existsSync(join(taskDir, "checks.ts"));
}

function extractArrayField(content: string, field: string): string[] {
  const regex = new RegExp(`${field}\\s*:\\s*\\[([^\\]]+)\\]`);
  const match = content.match(regex);
  if (!match) return [];

  return match[1]
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
    .filter(Boolean);
}

/**
 * Read a task's `execution` preference statically. Mirrors the
 * other `extract*` helpers so `task-run` can pick a dispatch mode without
 * executing the user's module (which would re-register checks). Strips `//`
 * line comments first so a documented example doesn't get mistaken for a
 * real declaration. `"auto"` and unknown values collapse to `undefined`
 * (== "no preference").
 */
