import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredCredentials = {
  backend_url: string;
  api_key: string;
  email?: string;
  task_root?: string;
  project?: string;
  /** Set when these credentials came from `apo profile use` — names the source profile. */
  profile_name?: string;
  created_at?: string;
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

/**
 * Remembered logins, one per backend. `apo login` is the switch: logging in
 * captures the whole context (backend, account, project, task root), and the
 * previous context is remembered here so switching back is instant and
 * non-destructive — `~/.apo/credentials` is the ACTIVE login, these are the
 * saved ones.
 */
export function loginsDir(): string {
  return join(homedir(), ".apo", "logins");
}

/** Stable, filesystem-safe key for a backend URL (host + path). */
export function backendKey(backendUrl: string): string {
  try {
    const url = new URL(backendUrl);
    return `${url.host}${url.pathname}`.replace(/[^a-zA-Z0-9.-]/g, "_").replace(/_+$/, "") || "default";
  } catch {
    return "default";
  }
}

function rememberedLoginPath(backendUrl: string): string {
  return join(loginsDir(), `${backendKey(backendUrl)}.json`);
}

export function readRememberedLogin(backendUrl: string): StoredCredentials | null {
  const path = rememberedLoginPath(backendUrl);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredCredentials;
    if (typeof parsed.backend_url === "string" && typeof parsed.api_key === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeRememberedLogin(creds: StoredCredentials): string {
  mkdirSync(loginsDir(), { recursive: true });
  const path = rememberedLoginPath(creds.backend_url);
  writeFileSync(path, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function forgetRememberedLogin(backendUrl: string): boolean {
  const path = rememberedLoginPath(backendUrl);
  if (!existsSync(path)) return false;
  rmSync(path, { force: false });
  return true;
}

export function listRememberedLogins(): { backend_url: string; email?: string; project?: string }[] {
  if (!existsSync(loginsDir())) return [];
  const entries: { backend_url: string; email?: string; project?: string }[] = [];
  for (const name of readdirSync(loginsDir())) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(loginsDir(), name), "utf8")) as StoredCredentials;
      if (typeof parsed.backend_url === "string" && typeof parsed.api_key === "string") {
        entries.push({ backend_url: parsed.backend_url, email: parsed.email, project: parsed.project });
      }
    } catch {
      // unreadable login file — skip it
    }
  }
  return entries.sort((a, b) => a.backend_url.localeCompare(b.backend_url));
}
