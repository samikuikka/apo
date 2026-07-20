import { parseArgs } from "./lib/args.ts";
import { bold, dim } from "./lib/format.ts";
import { pathToFileURL } from "node:url";

const VERSION = "0.1.0";

type CommandHandler = (argv: string[]) => Promise<number>;

type CommandEntry = {
  handler: CommandHandler;
  help: string;
  args?: [string, string][];
  options?: [string, string][];
  examples?: string[];
  note?: string;
};

const commands: Record<string, CommandEntry> = {
  login: {
    handler: loadCommand("login"),
    help: "Authenticate with email + password",
    options: [
      ["--force", "Re-authenticate even if already logged in"],
      ["--email <addr>", "Pre-fill email (skip prompt)"],
      ["--password <pw>", "Supply password (skip masked prompt)"],
      ["--project <id>", "Skip project picker (id, name, or prefix)"],
    ],
    examples: [
      "apo login",
      "apo login --force",
      "apo login --email me@corp.com --project my-proj",
    ],
    note: "First-time setup — no prior credentials needed. Saves key to ~/.apo/credentials.",
  },
  logout: {
    handler: loadCommand("logout"),
    help: "Clear saved credentials (sign out)",
    note: "Deletes ~/.apo/credentials. No backend connection needed.",
  },
  "project source show": {
    handler: loadCommand("project-source-show"),
    help: "Show the configured project task source",
    note: "Requires --project + backend auth.",
  },
  "project source set": {
    handler: loadCommand("project-source-set"),
    help: "Create or replace the project task source",
    options: [
      ["--type <git|filesystem|demo>", "Source type (required)"],
      ["--repo <url>", "Repository URL (required for git)"],
      ["--ref <branch>", "Git ref (default: main)"],
      ["--subpath <path>", "Subpath within repo or source"],
      ["--path <dir>", "Filesystem path (required for filesystem)"],
      ["--name <text>", "Display name"],
      ["--seed <id>", "Demo seed id (default: default)"],
    ],
    examples: [
      "apo project source set --type git --repo owner/repo --ref main",
      "apo project source set --type filesystem --path ./tasks",
    ],
    note: "Requires --project + backend auth.",
  },
  "project source sync": {
    handler: loadCommand("project-source-sync"),
    help: "Sync the project task source into task inventory",
    note: "Requires --project + backend auth.",
  },
  "project init-tasks": {
    handler: loadCommand("project-init-tasks"),
    help: "Configure and sync a GitHub-backed task source",
    options: [
      ["--repo <owner/repo>", "GitHub repo (required; accepts URL or owner/repo)"],
      ["--branch <name>", "Git ref (default: main)"],
      ["--subpath <path>", "Subpath within repo"],
      ["--name <text>", "Display name (default: owner/repo)"],
    ],
    examples: [
      "apo project init-tasks --repo owner/repo",
      "apo project init-tasks --repo owner/repo --branch dev --subpath tasks",
    ],
    note: "Opens browser for GitHub OAuth on first sync. Requires --project + backend auth.",
  },
  "project list": {
    handler: loadCommand("project-list"),
    help: "List projects you can access",
    note: "Requires backend auth. Active project marked with *.",
  },
  "project create": {
    handler: loadCommand("project-create"),
    help: "Create a project and mint an API key from email + password",
    args: [
      ["<name>", "Project name"],
    ],
    options: [
      ["--email <email>", "Account email (required)"],
      ["--password <password>", "Account password (required)"],
      ["--trace-content-policy <off|redacted|full>", "Trace content policy (default: redacted)"],
      ["--scope <full|ingest>", "API key scope (default: full)"],
      ["--backend <url>", "Backend URL (default: http://localhost:8000)"],
      ["--json", "Machine-readable JSON output"],
    ],
    examples: [
      "apo project create my-project --email me@example.com --password secret",
    ],
    note: "Solves the first-run chicken-and-egg: creates the project and saves credentials in one call, so `apo login` can proceed without a dashboard round-trip.",
  },
  "project use": {
    handler: loadCommand("project-use"),
    help: "Switch the active project",
    args: [
      ["[id|name]", "Project id, name, or unique prefix (optional)"],
    ],
    options: [
      ["--project <id>", "Alternative to positional argument"],
    ],
    examples: [
      "apo project use",
      "apo project use my-project",
    ],
    note: "Opens interactive picker if no argument given. Requires prior login.",
  },
  "project config": {
    handler: loadCommand("project-config"),
    help: "Read or write project-level CLI preferences",
    args: [
      ["<set|unset|show>", "Subcommand"],
      ["<key>", "Config key (currently: default-execution)"],
      ["[value]", "Value for set (local | backend)"],
    ],
    examples: [
      "apo project config set default-execution local",
      "apo project config set default-execution backend",
      "apo project config unset default-execution",
      "apo project config show default-execution",
    ],
    note: "default-execution is the project-level default for where `apo task run` dispatches (SPEC-136). Stored per-machine in ~/.apo/credentials — lower priority than a task's own execution declaration.",
  },
  "project sync-tasks": {
    handler: loadCommand("project-sync-tasks"),
    help: "Sync the configured project task inventory",
    note: "Requires --project + backend auth.",
  },
  "task list": {
    handler: loadCommand("task-list"),
    help: "List discovered tasks",
    examples: [
      "apo task list",
      "apo task list --json",
    ],
    note: "Uses backend (with --project) or scans --dir locally.",
  },
  "task show": {
    handler: loadCommand("task-show"),
    help: "Show task details",
    args: [
      ["<task-id>", "Task identifier"],
    ],
    examples: [
      "apo task show meeting-summary",
    ],
    note: "Uses backend (with --project) or local discovery. Supports --json.",
  },
  "task run": {
    handler: loadCommand("task-run"),
    help: "Run a task",
    args: [
      ["<task-id | path>", "Task id or filesystem path"],
    ],
    options: [
      ["--ci", "CI mode: records CI metadata, uses strict exit codes"],
      ["--local", "Run on this machine but record as a backend task run (override; for tasks needing dev-machine credentials / VPC / stage)"],
      ["--remote", "Force backend execution (symmetric to --local); overrides a task's execution: 'local' or a 'local' project default"],
    ],
    examples: [
      "apo task run meeting-summary",
      "apo task run ./tasks/my-task",
      "apo task run meeting-summary --json",
      "apo task run bind-e2e --local",
    ],
    note: "Dispatch order: --local/--remote flag > task's execution declaration > project default-execution > reachability. A task with execution: \"local\" (or a project with default-execution local) runs locally with no flag. Set project default via `apo project config set default-execution local`. Exit codes: 0=pass, 1=fail, 2=error.",
  },
  "runs list": {
    handler: loadCommand("runs-list"),
    help: "List past runs from backend",
    options: [
      ["--task <id>", "Filter by task id"],
      ["--status <s>", "Filter by run status"],
      ["--limit <n>", "Max results to show"],
    ],
    examples: [
      "apo runs list",
      "apo runs list --task meeting-summary --limit 5",
    ],
    note: "Requires backend auth. Supports --json.",
  },
  "runs show": {
    handler: loadCommand("runs-show"),
    help: "Show run details (checks, failures, cost) from backend",
    args: [
      ["[run-id]", "Run ID, unique prefix, or 'last' (default: latest run)"],
    ],
    options: [
      ["--verbose", "Show all assertions (incl. passing) + LLM judge responses"],
      ["--exit-status", "Exit non-zero if the run failed (for CI / scripting)"],
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
    ],
    examples: [
      "apo runs show              # latest run",
      "apo runs show de89cab      # by prefix",
      "apo runs show last --task meeting-summary",
      "apo runs show de89cab --verbose --exit-status",
    ],
    note: "Accepts run-id prefixes. Requires backend auth.",
  },
  "traces list": {
    handler: loadCommand("traces-list"),
    help: "List recent traces from backend",
    options: [
      ["--task <id>", "Filter by task id"],
      ["--limit <n>", "Max results (default: 20)"],
    ],
    examples: [
      "apo traces list --limit 10",
    ],
    note: "Requires backend auth. Supports --json.",
  },
  "traces show": {
    handler: loadCommand("traces-show"),
    help: "Show trace call details (timing, cost, tokens)",
    args: [
      ["<trace-id>", "Trace ID or unique prefix"],
    ],
    options: [
      ["--verbose", "Show per-call input/output/messages"],
      ["--errors-only", "Show only error/warning calls"],
    ],
    examples: [
      "apo traces show abc123",
      "apo traces show abc123 --errors-only",
    ],
    note: "Accepts trace-id prefixes. Requires backend auth.",
  },
  "batch list": {
    handler: loadCommand("batch-list"),
    help: "List batch runs from backend",
    options: [
      ["--status <s>", "Filter by batch status"],
    ],
    examples: [
      "apo batch list",
    ],
    note: "Requires backend auth. Supports --json.",
  },
  "batch show": {
    handler: loadCommand("batch-show"),
    help: "Show batch run details from backend",
    args: [
      ["<batch-id>", "Batch ID or unique prefix"],
    ],
    options: [
      ["--watch", "Auto-refresh every 3s until complete"],
    ],
    examples: [
      "apo batch show abc123",
      "apo batch show abc123 --watch",
    ],
    note: "Accepts batch-id prefixes. Requires backend auth.",
  },
  "batch create": {
    handler: loadCommand("batch-create"),
    help: "Create a new batch run on backend",
    options: [
      ["--tasks <id1,id2,...>", "Comma-separated task ids (required)"],
    ],
    examples: [
      "apo batch create --tasks meeting-summary,code-review",
    ],
    note: "Without --project, task ids resolve from local --dir. Requires backend auth.",
  },
};

function loadCommand(name: string): CommandHandler {
  return async (argv: string[]) => {
    const mod = await import(`./commands/${name}.ts`);
    return mod.run(argv);
  };
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(`apo ${VERSION}`);
    return 0;
  }

  const matched = positional.length > 0 ? findCommand(positional) : null;

  if (flags.help) {
    if (matched) {
      printCommandHelp(matched.key, commands[matched.key]);
    } else {
      printHelp();
    }
    return 0;
  }

  if (!matched) {
    if (positional.length > 0) {
      console.error(`Unknown command: ${positional.join(" ")}`);
      console.error("");
    }
    printHelp();
    return positional.length > 0 ? 2 : 0;
  }

  const command = commands[matched.key];

  const commandArgs = positional.slice(matched.keyParts.length);
  for (const [key, value] of Object.entries(flags)) {
    if (key === "help" || key === "version") continue;
    if (typeof value === "string") {
      commandArgs.push(`--${key}`, value);
    } else if (value === true) {
      commandArgs.push(`--${key}`);
    }
  }
  return command.handler(commandArgs);
}

function findCommand(positional: string[]): { key: string; keyParts: string[] } | null {
  const entries = Object.keys(commands)
    .map((key) => ({ key, keyParts: key.split(" ") }))
    .sort((left, right) => right.keyParts.length - left.keyParts.length);

  for (const entry of entries) {
    if (entry.keyParts.length > positional.length) {
      continue;
    }
    if (entry.keyParts.every((part, index) => positional[index] === part)) {
      return entry;
    }
  }

  return null;
}

function pad(label: string, width: number): string {
  return label.padEnd(width + 2);
}

function printCommandHelp(key: string, entry: CommandEntry): void {
  const head = `apo ${key}`;
  console.log(bold(head));
  console.log(`  ${entry.help}`);
  console.log("");

  console.log(bold("Usage:"));
  const argSummary = entry.args?.map((a) => a[0]).join(" ") ?? "";
  const optSummary = entry.options?.length ? " [options]" : "";
  console.log(`  apo ${key}${argSummary ? ` ${argSummary}` : ""}${optSummary}`);
  console.log("");

  if (entry.args?.length) {
    console.log(bold("Arguments:"));
    const w = Math.max(...entry.args.map((a) => a[0].length));
    for (const [name, desc] of entry.args) {
      console.log(`  ${pad(name, w)} ${desc}`);
    }
    console.log("");
  }

  if (entry.options?.length) {
    console.log(bold("Options:"));
    const w = Math.max(...entry.options.map((o) => o[0].length));
    for (const [flag, desc] of entry.options) {
      console.log(`  ${pad(flag, w)} ${desc}`);
    }
    console.log("");
  }

  if (entry.examples?.length) {
    console.log(bold("Examples:"));
    for (const ex of entry.examples) {
      console.log(`  ${ex}`);
    }
    console.log("");
  }

  if (entry.note) {
    console.log(dim(entry.note));
    console.log("");
  }

  console.log(dim("Global flags: --backend, --project, --json, --dir, --actor, --api-key"));
  console.log(dim("Run 'apo --help' for the full list."));
}

function printHelp(): void {
  console.log(bold("apo — Agent Task Runner"));
  console.log("");
  console.log(bold("Quick start:"));
  console.log("  apo login                Authenticate");
  console.log("  apo project use          Pick a project");
  console.log("  apo task list            See available tasks");
  console.log("  apo task run <task-id>   Run a task");
  console.log("  apo runs show <run-id>   Inspect results + failures");
  console.log("");
  console.log(bold("Commands:"));
  console.log("");

  const entries = Object.entries(commands);
  const maxWidth = Math.max(...entries.map(([k]) => k.length));

  for (const [name, entry] of entries) {
    console.log(`  ${name.padEnd(maxWidth + 2)} ${entry.help}`);
  }

  console.log("");
  console.log(bold("Global Flags:"));
  console.log("  --dir <path>       Task root directory (default: ./e2e)");
  console.log("  --backend <url>    Backend URL (default: http://localhost:8000)");
  console.log("  --project <id>     Project ID");
  console.log("  --actor <name>     Actor name recorded in run metadata");
  console.log("  --api-key <key>    API key (default: read from $APO_API_KEY or ~/.apo/credentials)");
  console.log("  --json             Machine-readable JSON output");
  console.log("  --help             Show help (use 'apo <command> --help' for per-command details)");
  console.log("  --version          Show version");
  console.log("");
  console.log(bold("Environment variables:"));
  console.log("  APO_TASK_ROOT      Default task root directory");
  console.log("  APO_BACKEND_URL    Default backend URL");
  console.log("  APO_PROJECT_ID     Default project ID");
  console.log("  APO_ACTOR          Default actor name");
  console.log("  APO_API_KEY        API key for backend auth");
}

// Only run when invoked directly as the entry point (not when imported, e.g.
// by tests). Without this guard the side-effect below would fire on import.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      // Force exit: Node's global fetch (undici) keeps its connection pool
      // alive, which would otherwise hold the event loop open and hang the CLI
      // after any network command.
      process.exit(code);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(2);
    });
}
