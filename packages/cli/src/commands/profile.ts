import { parseArgs, getBoolFlag, getFlagValue } from "../lib/args.ts";
import { checkSavedKey } from "../lib/api.ts";
import {
  readCredentials,
  writeCredentials,
  listRememberedLogins,
  readRememberedLogin,
} from "../lib/credentials.ts";
import {
  activeProfileName,
  isValidProfileName,
  listProfiles,
  profilesDir,
  readProfile,
  removeProfile,
  writeProfile,
  type Profile,
} from "../lib/profiles.ts";
import { dim, green, red } from "../lib/format.ts";

/**
 * `apo profile` — named connection contexts. `save` captures the current
 * login under a name, `use` verifies and switches everything (backend, key,
 * project, task root) in one command, `list` shows profiles plus the legacy
 * per-backend remembered logins.
 */
export async function run(argv: string[]): Promise<number> {
  const sub = argv[0] ?? "list";
  const rest = argv.slice(1);

  switch (sub) {
    case "list":
      return list();
    case "use":
      return use(rest);
    case "save":
      return save(rest);
    case "remove":
      return remove(rest);
    default:
      console.error(red(`Unknown profile subcommand: ${sub}`));
      console.error(dim("Usage: apo profile <list | use | save | remove>"));
      return 2;
  }
}

function list(): number {
  const active = activeProfileName();
  const profiles = listProfiles();
  const legacy = listRememberedLogins();

  if (profiles.length === 0 && legacy.length === 0) {
    console.log(dim("No profiles saved yet."));
    console.log(dim("  Save the current login with: apo profile save <name>"));
    return 0;
  }

  for (const p of profiles) {
    const marker = p.name === active ? green("*") : " ";
    console.log(`${marker} ${p.name.padEnd(16)} ${p.email ?? "(no email)"}  ${p.backend_url}  ${p.project ?? dim("(no project)")}`);
  }
  for (const l of legacy) {
    console.log(`  ${dim(`${hostLabel(l.backend_url).padEnd(16)} ${l.email ?? "(no email)"}  ${l.backend_url}  ${l.project ?? "(no project)"}  (login — switch: apo login --backend ${l.backend_url})`)}`);
  }
  console.log("");
  console.log(dim("Switch with: apo profile use <name>"));
  return 0;
}

async function use(argv: string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const target = positional[0];
  const profiles = listProfiles();

  if (!target) {
    console.error(red("Which profile? Usage: apo profile use <name>"));
    console.error(dim(`  Available: ${profiles.map((p) => p.name).join(", ") || "(none)"}`));
    return 2;
  }

  const chosen = resolveByName(profiles, target);
  if (!chosen.ok) {
    return 2;
  }
  const profile = chosen.profile;

  // Never switch blindly: verify the key against the backend first. An
  // unreachable backend may be a typo'd URL; a rejected key means the profile
  // needs re-saving. Either way the active credentials stay untouched.
  const status = await checkSavedKey(profile.backend_url, profile.api_key);
  if (status === "unknown") {
    console.error(red(`Cannot reach ${profile.backend_url} to verify profile "${profile.name}".`));
    return 2;
  }
  if (status === "invalid") {
    console.error(red(`The key for profile "${profile.name}" was rejected by ${profile.backend_url}.`));
    console.error(dim("  Refresh it: apo login --backend " + profile.backend_url + " (then apo profile save " + profile.name + " --force)"));
    return 2;
  }

  const { name, ...creds } = profile;
  const path = writeCredentials({ ...creds, profile_name: name });
  console.log(green(`✓ Switched to ${name} (${profile.email ?? profile.backend_url})`));
  console.log(dim(`  Backend:    ${profile.backend_url}`));
  console.log(dim(`  Project:    ${profile.project ?? "(none)"}`));
  console.log(dim(`  Task root:  ${profile.task_root ?? "./e2e"}`));
  console.log(dim(`  Active credentials: ${path}`));
  return 0;
}

function save(argv: string[]): number {
  const { flags, positional } = parseArgs(argv);
  const force = getBoolFlag(flags, "force");
  const fromLogin = getFlagValue(flags, "from-login");

  const existing = readCredentials();
  if (!existing) {
    console.error(red("Not logged in. Run `apo login` first."));
    return 2;
  }

  let name = positional[0];
  let source = existing;

  if (fromLogin) {
    const remembered = readRememberedLogin(fromLogin);
    if (!remembered) {
      console.error(red(`No remembered login for ${fromLogin}.`));
      return 2;
    }
    source = remembered;
  }

  if (!name) {
    name = hostLabel(source.backend_url);
  }
  if (!isValidProfileName(name)) {
    console.error(red(`Invalid profile name "${name}". Use letters, digits, dots, dashes, underscores; must not start with a dot or dash.`));
    return 2;
  }
  if (readProfile(name) && !force) {
    console.error(red(`Profile "${name}" already exists. Use --force to overwrite.`));
    return 2;
  }

  const { profile_name: _drop, ...creds } = source;
  const path = writeProfile({ ...creds, name });
  console.log(green(`✓ Saved profile ${name}`));
  console.log(dim(`  Backend: ${source.backend_url}`));
  console.log(dim(`  File:    ${path}`));
  console.log(dim(`  Switch to it with: apo profile use ${name}`));
  return 0;
}

function remove(argv: string[]): number {
  const { positional } = parseArgs(argv);
  const name = positional[0];
  if (!name) {
    console.error(red("Which profile? Usage: apo profile remove <name>"));
    return 2;
  }
  if (!readProfile(name)) {
    console.error(red(`No profile named "${name}".`));
    return 2;
  }
  if (!removeProfile(name)) {
    return 2;
  }
  console.log(green(`✓ Removed profile ${name}`));
  console.log(dim(`  (Files kept in ${profilesDir()} for other profiles are untouched.)`));
  return 0;
}

function resolveByName(profiles: Profile[], target: string): { ok: true; profile: Profile } | { ok: false } {
  const exact = profiles.find((p) => p.name === target);
  if (exact) return { ok: true, profile: exact };

  const prefixed = profiles.filter((p) => p.name.startsWith(target));
  if (prefixed.length === 0) {
    console.error(red(`No profile matching "${target}".`));
    console.error(dim(`  Available: ${profiles.map((p) => p.name).join(", ") || "(none)"}`));
    return { ok: false };
  }
  if (prefixed.length > 1) {
    console.error(red(`"${target}" matches multiple profiles:`));
    console.error(dim(`  ${prefixed.map((p) => p.name).join(", ")}`));
    console.error(dim("  Use a longer prefix."));
    return { ok: false };
  }
  return { ok: true, profile: prefixed[0] };
}

/** Short, filesystem-friendly label for a backend URL: its host. */
function hostLabel(backendUrl: string): string {
  try {
    return new URL(backendUrl).host.replace(/[^a-zA-Z0-9.-]/g, "-");
  } catch {
    return "default";
  }
}
