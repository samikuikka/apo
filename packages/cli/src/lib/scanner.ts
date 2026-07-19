import { existsSync, lstatSync, readdirSync } from "fs";
import { join, resolve } from "path";

export type ScanOptions = {
  rootDir: string;
  ignoreDirs?: Set<string>;
  ignoreHidden?: boolean;
  followSymlinks?: boolean;
  maxDepth?: number;
  onError?: (path: string, error: unknown) => void;
};

const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".jj",
  ".claude",
  ".worktrees",
  ".opencode",
  ".codex",
  ".mimocode",
  ".next",
  "dist",
  "build",
  "coverage",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".pnpm-store",
]);

export function listTaskCandidateDirs(options: ScanOptions): string[] {
  const absoluteRoot = resolve(options.rootDir);

  if (!existsSync(absoluteRoot)) {
    throw new Error(`Task directory not found: ${absoluteRoot}`);
  }

  const stat = safeStat(absoluteRoot, options.onError);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Task directory not found: ${absoluteRoot}`);
  }

  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const ignoreHidden = options.ignoreHidden ?? true;
  const followSymlinks = options.followSymlinks ?? false;
  const maxDepth = options.maxDepth ?? Infinity;
  const results: string[] = [];

  walk(absoluteRoot, 0);
  return results;

  function walk(currentDir: string, depth: number): void {
    if (depth > maxDepth) {
      return;
    }

    const hasEval = existsSync(currentDir) &&
      readdirSync(currentDir).some((f) => f.endsWith(".eval.ts"));
    if (hasEval) {
      results.push(currentDir);
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch (error) {
      options.onError?.(currentDir, error);
      return;
    }

    for (const name of entries.sort()) {
      if (ignoreDirs.has(name)) {
        continue;
      }
      if (ignoreHidden && name.startsWith(".")) {
        continue;
      }

      const childPath = join(currentDir, name);
      const childStat = safeStat(childPath, options.onError);
      if (!childStat) {
        continue;
      }

      if (childStat.isSymbolicLink() && !followSymlinks) {
        continue;
      }
      if (!childStat.isDirectory()) {
        continue;
      }

      walk(childPath, depth + 1);
    }
  }
}

function safeStat(
  path: string,
  onError?: (path: string, error: unknown) => void,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    onError?.(path, error);
    return undefined;
  }
}
