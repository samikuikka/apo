import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readCredentials, type StoredCredentials } from "./credentials.ts";
import { red } from "./format.ts";

/**
 * Named profiles: a saved connection context (backend, API key, email,
 * project, task root) under a short name, so `apo profile use prod` switches
 * everything in one command. Unlike remembered logins (one per backend, keyed
 * by host), profiles are keyed by NAME — two profiles may share a backend
 * with different accounts.
 */
export type Profile = StoredCredentials & {
  name: string;
};

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function profilesDir(): string {
  return join(homedir(), ".apo", "profiles");
}

export function isValidProfileName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.includes("..");
}

function profilePath(name: string): string {
  return join(profilesDir(), `${name}.json`);
}

export function readProfile(name: string): Profile | null {
  const path = profilePath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Profile;
    if (
      typeof parsed.name === "string" &&
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

export function writeProfile(profile: Profile): string {
  mkdirSync(profilesDir(), { recursive: true });
  const path = profilePath(profile.name);
  writeFileSync(path, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/**
 * Delete a profile file. Refuses (returns false) when it is the active
 * profile — switching away first is the safe path, and silently deleting the
 * live context's source leaves `profile_name` pointing at nothing.
 */
export function removeProfile(name: string): boolean {
  if (activeProfileName() === name) {
    console.error(
      red(`Profile "${name}" is active. Switch to another profile first (apo profile use <name>).`),
    );
    return false;
  }
  const path = profilePath(name);
  if (!existsSync(path)) return false;
  rmSync(path, { force: false });
  return true;
}

export function listProfiles(): Profile[] {
  if (!existsSync(profilesDir())) return [];
  const entries: Profile[] = [];
  for (const file of readdirSync(profilesDir())) {
    if (!file.endsWith(".json")) continue;
    const profile = readProfile(file.replace(/\.json$/, ""));
    if (profile) entries.push(profile);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Name of the profile the active credentials came from, if any. */
export function activeProfileName(): string | undefined {
  return readCredentials()?.profile_name;
}
