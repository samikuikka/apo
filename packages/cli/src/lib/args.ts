export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      break;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      i += 1;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      i += 1;
      continue;
    }

    if (arg === "--json") {
      flags.json = true;
      i += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }

    positional.push(arg);
    i += 1;
  }

  return { positional, flags };
}

export function requirePositional(
  positional: string[],
  index: number,
  name: string,
): string {
  const value = positional[index];
  if (!value) {
    throw new Error(`Missing required argument: <${name}>`);
  }
  return value;
}

export function getFlag(
  flags: Record<string, string | boolean>,
  name: string,
): string | undefined {
  const value = flags[name];
  if (typeof value !== "string") {
    return undefined;
  }
  return value;
}

export function getBoolFlag(
  flags: Record<string, string | boolean>,
  name: string,
): boolean {
  return flags[name] === true || flags[name] === "true";
}

export { getFlag as getFlagValue };
