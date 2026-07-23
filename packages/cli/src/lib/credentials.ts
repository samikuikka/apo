import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredCredentials = {
  backend_url: string;
  api_key: string;
  email?: string;
  task_root?: string;
  project?: string;
  created_at?: string;
  /**
   * Project-level default for where `apo task run` executes
   * (SPEC-136). Stored per credential set so different backends can have
   * different defaults. Lower priority than a task's own `execution`
   * declaration; overrideable per-invocation by `--local` / `--remote`.
   * Old credential files lack the field → treated as unset.
   */
  default_execution?: "local" | "backend";
};

export function readCredentials(): StoredCredentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as StoredCredentials;
    if (
      typeof parsed.backend_url === "string" &&
      typeof parsed.api_key === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: StoredCredentials): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload: StoredCredentials = {
    ...creds,
    created_at: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", {
    mode: 0o600,
  });
  return path;
}

export function clearCredentials(): boolean {
  const path = credentialsPath();
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path, { force: false });
  return true;
}

export function credentialsPath(): string {
  return join(homedir(), ".apo", "credentials");
}
