import { parseArgs } from "../lib/args.ts";
import { readCredentials, writeCredentials, type StoredCredentials } from "../lib/credentials.ts";
import { bold, dim, green, red } from "../lib/format.ts";

/**
 * `apo project config <subcommand> <key> [value]` (SPEC-136).
 *
 * Today the only configurable key is `default-execution`, the project-level
 * default for where `apo task run` dispatches. Stored in credentials (per
 * machine) rather than on the backend `ProjectDB` — it's a CLI preference,
 * not a project property.
 *
 *   apo project config set   default-execution local|backend
 *   apo project config unset default-execution
 *   apo project config show  default-execution
 */
const ALLOWED_VALUES = ["local", "backend"] as const;
type DefaultValue = (typeof ALLOWED_VALUES)[number];

const ALLOWED_KEYS = ["default-execution"] as const;
type ConfigKey = (typeof ALLOWED_KEYS)[number];

export async function run(argv: string[]): Promise<number> {
  const { positional } = parseArgs(argv);

  const subcommand = positional[0];
  if (!subcommand || !isSubcommand(subcommand)) {
    printUsage();
    return 2;
  }

  const existing = readCredentials();
  if (!existing) {
    console.error(red("Not logged in. Run `apo login` first."));
    return 2;
  }

  const key = positional[1];
  if (!key || !isAllowedKey(key)) {
    console.error(red(`Unknown config key: ${key ?? "(none)"}`));
    console.error(dim(`  Supported keys: ${ALLOWED_KEYS.join(", ")}`));
    return 2;
  }

  switch (subcommand) {
    case "set":
      return doSet(existing, positional[2]);
    case "unset":
      return doUnset(existing);
    case "show":
      return doShow(existing);
  }
}

function doSet(existing: StoredCredentials, rawValue: string | undefined): number {
  if (!rawValue || !isAllowedValue(rawValue)) {
    console.error(
      red(`Invalid value for default-execution: ${rawValue ?? "(none)"}`),
    );
    console.error(dim(`  Allowed: ${ALLOWED_VALUES.join(", ")}`));
    return 2;
  }
  writeCredentials({ ...existing, default_execution: rawValue });
  console.log(green(`\u2713 default-execution set to ${rawValue}.`));
  return 0;
}

function doUnset(existing: StoredCredentials): number {
  // Drop only default_execution, keep everything else round-tripping intact.
  const { default_execution: _drop, ...rest } = existing;
  writeCredentials(rest);
  console.log(green("\u2713 default-execution cleared."));
  return 0;
}

function doShow(existing: StoredCredentials): number {
  const value = existing.default_execution;
  if (!value) {
    console.log(dim("default-execution: unset"));
  } else {
    console.log(`${bold("default-execution")}: ${value}`);
  }
  return 0;
}

function isSubcommand(value: string): value is "set" | "unset" | "show" {
  return value === "set" || value === "unset" || value === "show";
}

function isAllowedKey(value: string): value is ConfigKey {
  return (ALLOWED_KEYS as readonly string[]).includes(value);
}

function isAllowedValue(value: string): value is DefaultValue {
  return (ALLOWED_VALUES as readonly string[]).includes(value);
}

function printUsage(): void {
  console.error(bold("apo project config <set|unset|show> <key> [value]"));
  console.error("");
  console.error("Keys:");
  console.error("  default-execution   Where `apo task run` dispatches by default");
  console.error("");
  console.error("Examples:");
  console.error("  apo project config set default-execution local");
  console.error("  apo project config set default-execution backend");
  console.error("  apo project config unset default-execution");
  console.error("  apo project config show default-execution");
}
