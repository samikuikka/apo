import { lstatSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { readCredentials, credentialsPath } from "./credentials.ts";

export type Config = {
  taskRoot: string;
  backendUrl: string;
  projectId: string | undefined;
  actor: string | undefined;
  apiKey: string | undefined;
  json: boolean;
  ci: boolean;
  /**
   * Project-level default for `apo task run` execution
   * (SPEC-136). Populated from `StoredCredentials.default_execution`.
   * Lower priority than a task's own `execution` declaration; overrideable
   * per-invocation by `--local` / `--remote`.
   */
  defaultExecution: "local" | "backend" | undefined;
  _rawFlags: Record<string, string | boolean>;
};

export function resolveConfig(
  flags: Record<string, string | boolean>,
  options?: { cwd?: string },
): Config {
  const stored = readCredentials();

  return {
    taskRoot: resolvePath(
      getFlagValue(flags, "dir"),
      "APO_TASK_ROOT",
      stored?.task_root ?? "./e2e",
      stored ? dirname(credentialsPath()) : undefined,
      options?.cwd,
    ),
    backendUrl: resolveString(
      getFlagValue(flags, "backend"),
      "APO_BACKEND_URL",
      stored?.backend_url ?? "http://localhost:8000",
    ),
    projectId: resolveOptionalString(
      getFlagValue(flags, "project"),
      "APO_PROJECT_ID",
    ) ?? stored?.project,
    actor: resolveOptionalString(
      getFlagValue(flags, "actor"),
      "APO_ACTOR",
    ),
    apiKey: resolveOptionalString(
      getFlagValue(flags, "api-key"),
      "APO_API_KEY",
    ) ?? stored?.api_key,
    json: flags.json === true,
    ci: flags.ci === true || process.env.CI === "true",
    defaultExecution: stored?.default_execution,
    _rawFlags: flags,
  };
}

function getFlagValue(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

function resolvePath(
  flagValue: string | undefined,
  envVar: string,
  defaultValue: string,
  storedBaseDir: string | undefined,
  cwd: string | undefined,
): string {
  if (flagValue) {
    return resolvePathAbsolute(flagValue, cwd);
  }

  const envValue = process.env[envVar];
  if (envValue) {
    return resolvePathAbsolute(envValue, cwd);
  }

  if (storedBaseDir && defaultValue && !isAbsolute(defaultValue)) {
    const repoRoot = findRepoRoot(storedBaseDir);
    return resolve(repoRoot, defaultValue);
  }

  return resolvePathAbsolute(defaultValue, cwd);
}

function resolvePathAbsolute(value: string, cwd?: string): string {
  return isAbsolute(value) ? value : resolve(cwd ?? process.cwd(), value);
}

function resolveString(
  flagValue: string | undefined,
  envVar: string,
  defaultValue: string,
): string {
  if (flagValue) return flagValue;
  const envValue = process.env[envVar];
  if (envValue) return envValue;
  return defaultValue;
}

function resolveOptionalString(
  flagValue: string | undefined,
  envVar: string,
): string | undefined {
  if (flagValue) return flagValue;
  return process.env[envVar];
}

function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  const root = resolve("/");

  while (true) {
    if (
      markerExists(current, ".git") ||
      markerExists(current, ".jj") ||
      markerExists(current, "pnpm-workspace.yaml") ||
      markerExists(current, "package.json")
    ) {
      return current;
    }

    if (current === root) {
      break;
    }
    current = dirname(current);
  }

  return resolve(startDir);
}

function markerExists(dir: string, name: string): boolean {
  try {
    return lstatSync(join(dir, name)).isDirectory() || lstatSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}
