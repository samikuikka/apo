import { parseArgs } from "./lib/args.ts";
import { bold, dim } from "./lib/format.ts";
import { isDirectInvocation } from "./lib/entrypoint.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")).version;

type CommandHandler = (argv: string[]) => Promise<number>;

type CommandEntry = {
  handler: CommandHandler;
  help: string;
  args?: [string, string][];
  options?: [string, string][];
  /** Flags the command accepts that are too minor for the Options table
   *  (rendered as one compact line instead of one row each). */
  extraFlags?: string[];
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
    note: "Sets the context every command uses: backend, project, task root. Logins are remembered per backend — switch back any time with apo login --backend <url>, no password needed.",
  },
  logout: {
    handler: loadCommand("logout"),
    help: "Clear saved credentials (sign out)",
    note: "Deletes ~/.apo/credentials. No backend connection needed.",
  },
  status: {
    handler: loadCommand("status"),
    help: "Show effective configuration (login, backend, project, task root)",
    note: "Prints exactly what commands will use, resolved from flags > environment > ~/.apo/credentials > defaults. No backend auth needed.",
  },
  run: {
    handler: loadCommand("run"),
    help: "Run evals interactively — pick tasks, pick a model, confirm, run",
    examples: [
      "apo run",
    ],
    note: "The human-facing runner: a folder tree of tasks (space checks a subset), a model picker with type-to-filter, and a run manifest before anything executes. Runs record exactly like `apo task run`. Needs a terminal — agents and CI should use `apo task run <id>`.",
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
  "task list": {
    handler: loadCommand("task-list"),
    help: "List runnable tasks (from the task root your login captured)",
    options: [
      ["--catalog", "List the backend's published inventory instead of the local task root"],
    ],
    examples: [
      "apo task list",
      "apo task list --catalog",
      "apo task list --json",
    ],
    note: "Same universe as task run: the task root your login captured. Falls back to the published catalog only when no local task root exists. The last line names the source.",
  },
  "task show": {
    handler: loadCommand("task-show"),
    help: "Show task details",
    args: [
      ["<task-id>", "Task identifier"],
    ],
    options: [
      ["--catalog", "Look the task up in the backend's published inventory"],
    ],
    examples: [
      "apo task show meeting-summary",
      "apo task show meeting-summary --catalog",
    ],
    note: "Same universe as task run (the task root your login captured); --catalog reads the published inventory. Supports --json.",
  },
  "task run": {
    handler: loadCommand("task-run"),
    help: "Run a task",
    args: [
      ["<task-id | path>", "Task id or filesystem path"],
    ],
    options: [
      ["--no-record", "Run on this machine WITHOUT recording (skips the backend entirely)"],
    ],
    examples: [
      "apo task run meeting-summary",
      "apo task run ./tasks/my-task",
      "apo task run meeting-summary --no-record",
    ],
    note: "Always executes on this machine (caller execution). Records the run when backend + project + credential are configured; a configured recording that cannot reach the backend exits 2 — use --no-record to skip recording. Exit codes: 0=pass, 1=fail, 2=error.",
  },
  "task publish": {
    handler: loadCommand("task-publish"),
    help: "Publish task metadata to the Apo Task Catalog",
    options: [
      ["--dir <path>", "Task root directory (default: from config)"],
      ["--project <id>", "Project to publish to (default: active project)"],
      ["--dry-run", "Print the publication document without sending"],
      ["--allow-empty", "Required to publish zero tasks (clears catalog)"],
      ["--json", "Machine-readable output"],
    ],
    examples: [
      "apo task publish",
      "apo task publish --dry-run --json",
      "apo task publish --dir ./tasks --project acme",
    ],
    note: "Scans local tasks and publishes bounded metadata only — no source files, prompts, or credentials leave your machine.",
  },
  connect: {
    handler: loadCommand("connect"),
    help: "Connect as a persistent source-owned executor",
    options: [
      ["--dir <path>", "Task root directory (default: from config)"],
      ["--project <id>", "Project to connect to (default: active project)"],
      ["--name <name>", "Display name for this machine"],
      ["--concurrency <n>", "Max parallel tasks (default: 4)"],
    ],
    examples: [
      "apo connect",
      "apo connect --project acme --concurrency 8",
    ],
    note: "Runs in the foreground. Discovers tasks locally, publishes nothing, and executes only assignments matching your published Task Catalog. Source files and credentials never leave your machine.",
  },
  "runs list": {
    handler: loadCommand("runs-list"),
    help: "List past runs from backend",
    options: [
      ["--task <id>", "Filter by task id"],
      ["--status <s>", "Filter by run status"],
      ["--model <m>", "Filter by adapter-reported model (repeatable; OR within model, AND with --effort)"],
      ["--effort <e>", "Filter by adapter-reported effort (repeatable; OR within effort, AND with --model)"],
      ["--limit <n>", "Max results to show"],
    ],
    examples: [
      "apo runs list",
      "apo runs list --task meeting-summary --limit 5",
      "apo runs list --model gpt-5.6-terra --effort high",
    ],
    note: "Requires backend auth. Supports --json. The Execution column shows the adapter-reported model · effort.",
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
    note: "Accepts run-id prefixes. Requires backend auth. Supports --json. Large per-check values (typically the deliverable re-sent per criterion) are shown as a one-line manifest; read full content with `apo runs deliverable <run-id> [name]` (fetches a deliverable once, not per check).",
  },
  "runs deliverable": {
    handler: loadCommand("runs-deliverable"),
    help: "Read a run's deliverables (manifest list, or one deliverable's full content)",
    args: [
      ["<run-id>", "Run ID, unique prefix, or 'last'"],
      ["[name]", "Deliverable name — omit to list all deliverables as a manifest"],
    ],
    options: [
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
      ["--output <path>", "Write a binary artifact to a file instead of stdout. Use '.' to auto-derive the original filename."],
    ],
    examples: [
      "apo runs deliverable de89cab             # manifest of all deliverables",
      "apo runs deliverable de89cab memorandum   # full content of one JSON deliverable",
      "apo runs deliverable de89cab verifier-log --output verifier.log",
      "apo runs deliverable last --task meeting-summary summary",
    ],
    note: "Accepts run-id prefixes. Requires backend auth. Fetches only the manifest, then exactly one body when a name is given — never the whole run. Binary artifacts require --output on an interactive terminal (use '.' to keep the original filename). Supports --json.",
  },
  "runs rejudge": {
    handler: loadCommand("runs-rejudge"),
    help: "Re-judge a completed run against its stored deliverables — without re-running the agent",
    args: [
      ["<run-id>", "Run ID, unique prefix, or 'last'"],
    ],
    options: [
      ["--judge-model <m>", "Judge model for t.judge checks (default: AGENT_TASK_JUDGE_MODEL / OPENROUTER_MODEL / OPENAI_MODEL env)"],
      ["--judge-base-url <url>", "OpenAI-compatible base URL for the judge (default: OPENROUTER_BASE_URL / OPENAI_BASE_URL env)"],
      ["--samples <n>", "Judge the same deliverables n times (1-50) for a per-test stability measure"],
      ["--dry-run", "Run the replay but do not record a judgment (LLM judge calls still cost money)"],
      ["--label <text>", "Operator label recorded on the judgment, e.g. 'sonnet-4.5 calibration'"],
      ["--definition-revision <id>", "Score against this revision instead of the run's pinned one (stamped on the judgment)"],
      ["--task-dir <path>", "Local checkout of the task directory (enables relative imports + fixture files)"],
      ["--verbose", "Show all assertions incl. LLM judge responses"],
      ["--exit-status", "Exit non-zero if the re-judged verdict fails (for CI / scripting)"],
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
    ],
    examples: [
      "apo runs rejudge last                       # current judge config, replay tests",
      "apo runs rejudge de89cab --judge-model anthropic/claude-sonnet-4.5",
      "apo runs rejudge de89cab --samples 5 --label 'judge variance'",
      "apo runs rejudge de89cab --dry-run",
    ],
    note: "Replays the run's FULL check set against its stored deliverables and records a new judgment — the original verdict is never overwritten. Judge API key comes from OPENROUTER_API_KEY / OPENAI_API_KEY env. Requires the run's deliverables to be complete. Trajectory assertions need the run's trace projection; without it they are recorded as unsupported.",
  },
  "runs correct": {
    handler: loadCommand("runs-correct"),
    help: "Correct a recorded test result — set effective PASS/FAIL or restore the recorded result",
    args: [
      ["<run-id>", "Run ID, unique prefix, or 'last'"],
      ["<test-id>", "Exact recorded top-level Test id to correct"],
    ],
    options: [
      ["--pass", "Set the test's effective result to PASS"],
      ["--fail", "Set the test's effective result to FAIL"],
      ["--clear", "Restore the recorded result (removes the active correction)"],
      ["--reason <text>", "Why (required for --pass/--fail, 3–1000 chars; recorded on the correction)"],
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
    ],
    examples: [
      "apo runs correct last \"report-is-complete\" --pass --reason \"Retention is present; judge missed the table\"",
      "apo runs correct de89cab \"no-failed-actions\" --fail --reason \"The trace contains a failed payment call\"",
      "apo runs correct de89cab \"report-is-complete\" --clear",
    ],
    note: "Records a human decision about existing evidence — the Check Report, assertions, judge responses, and judgments stay untouched. Run/Batch verdicts, lists, stats, and runs show --exit-status all use the effective result. Exit 0 on success (including idempotent retry), 2 on usage/API failure. Never prompts — safe for agents and CI.",
  },
  "runs delete": {
    handler: loadCommand("runs-delete"),
    help: "Permanently delete runs whose results are garbage (harness failure, bad environment)",
    args: [
      ["<run-id>...", "Run ID, unique prefix, or 'last' — one or more"],
    ],
    options: [
      ["--yes", "Required — confirms the irreversible delete"],
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
    ],
    examples: [
      "apo runs delete de89cab --yes",
      "apo runs delete last --yes",
      "apo runs delete run_aa1100 run_bb2200 --yes",
    ],
    note: "Destructive: removes the run's checks, judgments, corrections, deliverables (rows and stored objects), attempt, and trace; the batch's rollups are recomputed and an emptied batch is removed. Terminal or cancelled runs only — cancel a live run first. Requires project admin. Without --yes, prints what would be deleted and exits 2. Exit 0 on success, 2 on usage/API failure. Never prompts — safe for agents and CI.",
  },
  "runs export": {
    handler: loadCommand("runs-export"),
    help: "Export a run as a self-contained JSON bundle (verdict, checks, evidence, trace)",
    args: [
      ["<run-id>", "Run ID, unique prefix, or 'last'"],
    ],
    options: [
      ["--out <file>", "Output path (default: run-<id>-<timestamp>.json in the cwd)"],
      ["--spans", "Include the raw OTel spans (largest section; calls are always included)"],
    ],
    examples: [
      "apo runs export de89cab",
      "apo runs export last --out bad-run.json",
      "apo runs export de89cab --spans",
    ],
    note: "The backup side of evidence retention: everything the run holds is embedded — verdict + projected checks, corrections, judgment evidence, deliverables (inline values and artifact bytes base64), attempt diagnostics, the pinned eval source, and the trace's calls. Export BEFORE evidence expires or the run is deleted; a bundle of an already-expired run carries the verdict but its trace/checks read empty. Requires backend auth. Never prompts — safe for agents and CI.",
  },
  "runs judgments": {
    handler: loadCommand("runs-judgments"),
    help: "List a run's judgments (original + re-judges), or show one judgment's checks",
    args: [
      ["<run-id>", "Run ID, unique prefix, or 'last'"],
      ["[judgment-id]", "Judgment ID — omit to list all judgments as summaries"],
    ],
    options: [
      ["--task <id>", "Filter 'last' to the latest run of a specific task"],
    ],
    examples: [
      "apo runs judgments de89cab",
      "apo runs judgments de89cab jdg_9f2a1c",
      "apo runs judgments last --task meeting-summary",
    ],
    note: "The original verdict is the first row (trigger=original). Re-judge with `apo runs rejudge <run-id>`. Supports --json.",
  },
  "traces list": {
    handler: loadCommand("traces-list"),
    help: "List recent traces from backend",
    options: [
      ["--task <id>", "Filter by task id"],
      ["--limit <n>", "Max results (default: 20)"],
      ["--service <name>", "Filter traces by service (resource service.name)"],
      ["--operation <name>", "Filter traces by span name (exact)"],
      ["--span-text <text>", "Free text over span names and attributes"],
      ["--attr <expr>", "Span attribute predicate, repeatable: key=v, key!=v, key>v, key>=v, key<v, key<=v, key~=v (contains), key? (exists), 'key in a,b'"],
    ],
    examples: [
      "apo traces list --limit 10",
      "apo traces list --service billing-api --attr http.status_code>=500",
      "apo traces list --attr customer.tier in enterprise,pro --span-text timeout",
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
      ["--verbose", "Show per-call type, raw span attributes, input/output/messages"],
      ["--errors-only", "Show only error/warning calls"],
    ],
    examples: [
      "apo traces show abc123",
      "apo traces show abc123 --errors-only",
    ],
    note: "Accepts trace-id prefixes. Requires backend auth. Supports --json. Header shows the projection's evidence capabilities; --verbose adds each call's resolved observation_type and raw OTLP span attributes.",
  },
  "traces import langfuse": {
    handler: loadCommand("traces-import-langfuse"),
    help: "Import a Langfuse trace into apo via the OTLP receiver",
    args: [
      ["<trace-id>", "Langfuse source trace id"],
    ],
    options: [
      ["--langfuse-host <url>", "Override LANGFUSE_HOST"],
      ["--max-observations <count>", "Safety ceiling (default 10000, range 1..50000)"],
      ["--wait <seconds>", "Poll the source until the trace looks fully ingested (quiet observation count + no dangling parent links), not just the first span"],
      ["--settle <seconds>", "Quiet period the observation count must hold before the trace counts as ingested (default 15; only with --wait)"],
      ["--trace-id <apo-trace-id>", "Emit spans under this trace id instead of the namespaced hash (merge into an existing run trace; 32-hex W3C)"],
      ["--parent-span-id <span-id>", "The span in the target trace the imported subtree hangs under (16-hex W3C); lets the completeness check tell an expected external parent from an un-ingested one"],
      ["--json", "Machine-readable LangfuseImportResult JSON"],
    ],
    examples: [
      "apo traces import langfuse 8f38c27a2c4b4bafb87a78e3a3d62b90",
      "apo traces import langfuse <id> --langfuse-host https://us.langfuse.com",
      "apo traces import langfuse <id> --wait 120",
      "apo traces import langfuse <run-trace-id> --trace-id <run-trace-id>",
    ],
    note: "Credentials are environment-only: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY (required) and LANGFUSE_HOST (optional). Keys never leave the CLI process. Re-running is safe and idempotent. Exit codes: 0 = imported and visible; 75 = source trace not ready (retryable); 2 = hard error. See the docs page for --wait/--settle ingestion gating and merge mode (--trace-id, --parent-span-id).",
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
    note: "Accepts batch-id prefixes. Requires backend auth. Supports --json.",
  },
  "batch delete": {
    handler: loadCommand("batch-delete"),
    help: "Permanently delete a batch run and every task run it owns",
    args: [
      ["<batch-id>", "Batch ID or unique prefix"],
    ],
    options: [
      ["--yes", "Required — confirms the irreversible delete"],
    ],
    examples: [
      "apo batch delete 9a3f2c --yes",
    ],
    note: "Destructive: removes the batch, all its task runs (checks, judgments, corrections, deliverables, attempts, traces), and its task revision bundles. Terminal batches only — cancel a live batch first. Requires project admin. Without --yes, prints what would be deleted and exits 2. Exit 0 on success, 2 on usage/API failure. Never prompts — safe for agents and CI.",
  },
  reprice: {
    handler: loadCommand("reprice"),
    help: "Re-compute stored call costs against current pricing (history rewrite)",
    options: [
      ["--project <id>", "Scope to a project"],
      ["--model-id <int>", "Scope to calls priced against a specific model row id"],
      ["--since <datetime>", "ISO datetime lower bound on call start (inclusive)"],
      ["--until <datetime>", "ISO datetime upper bound on call start (exclusive)"],
      ["--dry-run", "Recompute without overwriting stored costs"],
      ["--admin-key <key>", "Admin API key (or APO_ADMIN_KEY env)"],
    ],
    examples: [
      "apo reprice",
      "apo reprice --project my-proj --since 2026-01-01T00:00:00Z",
      "apo reprice --model-id 3 --dry-run",
    ],
    note:
      "Operator-only history rewrite. Requires --admin-key (ADMIN_API_KEY on the backend). Provided-cost and pre-migration calls are skipped.",
  },
};

function loadCommand(name: string): CommandHandler {
  return async (argv: string[]) => {
    const mod = await import(`./commands/${name}.ts`);
    return mod.run(argv);
  };
}

/** Flags every command accepts. */
const GLOBAL_FLAGS = new Set([
  "help", "h", "version", "v", "json",
  "dir", "backend", "project", "actor", "api-key",
]);

function validFlagNames(entry: CommandEntry): Set<string> {
  const names = new Set(GLOBAL_FLAGS);
  for (const [flag] of entry.options ?? []) {
    const name = flag.split(/\s+/)[0];
    if (name.startsWith("--")) {
      names.add(name.slice(2));
    }
  }
  for (const name of entry.extraFlags ?? []) {
    names.add(name);
  }
  return names;
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
      printHelp();
      return 2;
    }
    for (const key of Object.keys(flags)) {
      if (!GLOBAL_FLAGS.has(key)) {
        console.error(`Unknown option: --${key}`);
        console.error("Run 'apo --help' for the full list.");
        return 2;
      }
    }
    printHelp();
    return 0;
  }

  const command = commands[matched.key];

  // Reject mistyped flags loudly: a silently-dropped --projct or --statu
  // filter is confidently-wrong output, not an error an agent can see.
  const accepted = validFlagNames(command);
  for (const key of Object.keys(flags)) {
    if (!accepted.has(key)) {
      console.error(`Unknown option: --${key} (apo ${matched.key})`);
      console.error(`Run 'apo ${matched.key} --help' for the valid options.`);
      return 2;
    }
  }

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

  if (entry.extraFlags?.length) {
    console.log(dim(`Also accepted: ${entry.extraFlags.map((f) => `--${f}`).join(", ")}`));
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

// Flush piped stdout/stderr before the forced exit (#155): writes to a pipe
// are asynchronous on Linux, so process.exit can truncate the final lines —
// including the Run:/Inspect: handover after a FAIL verdict. An
// empty write's callback fires once previously queued writes have drained.
async function flushAndExit(code: number): Promise<never> {
  await new Promise<void>((resolve) =>
    process.stdout.write("", () => resolve()),
  );
  await new Promise<void>((resolve) =>
    process.stderr.write("", () => resolve()),
  );
  process.exit(code);
}

// Only run when invoked directly as the entry point (not when imported, e.g.
// by tests). Without this guard the side-effect below would fire on import.
if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => {
      // Force exit (after flushing): Node's global fetch (undici) keeps its
      // connection pool alive, which would otherwise hold the event loop
      // open and hang the CLI after any network command.
      flushAndExit(code);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      flushAndExit(2);
    });
}
