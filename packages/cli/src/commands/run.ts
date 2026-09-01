/**
 * `apo run` — the human-facing way to run evals. Interactive on a
 * terminal: pick task(s) from a folder tree, pick a model, review the run
 * manifest, Enter executes through the same caller-executor machinery as
 * `apo task run` (runs are recorded identically). Agents and CI should
 * keep using `apo task run` — strict flags, exit codes, no prompts.
 */
import { parseArgs } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { discoverTaskMeta, type TaskMeta } from "../lib/task-meta.ts";
import {
  effectiveModelSource,
  hasProviderKey,
  resolveEnvView,
  type EnvView,
} from "../lib/env-view.ts";
import { fetchModelOptions, type ModelOption } from "../lib/models-list.ts";
import { askText, pickTree, shutdownInput, waitKey, type TreeNode } from "../lib/tui.ts";
import { bold, cyan, dim, formatTable, green, passFail, red } from "../lib/format.ts";
import { run as runTaskCommand } from "./task-run.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags.json) {
    console.error(red("error: --json is not available on apo run — it's interactive. Use `apo task run <id> --json` for machine output."));
    return 2;
  }
  if (!process.stdin.isTTY) {
    console.error(red("error: apo run is interactive and needs a terminal."));
    console.error(dim("For scripts and agents: `apo task run <task-id>` (strict flags, exit codes, no prompts)."));
    return 2;
  }

  const config = resolveConfig({});
  let tasks: TaskMeta[];
  try {
    tasks = [...discoverTaskMeta(config.taskRoot)].sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    tasks = [];
  }
  if (tasks.length === 0) {
    console.error(red(`error: no tasks found under ${config.taskRoot}`));
    console.error(dim("Set a task root with `apo login` (run it from your task repository) or --dir / APO_TASK_ROOT."));
    return 2;
  }

  const models = await fetchModelOptions(config);
  const selection = await driveFlow(tasks, models);
  if (selection === null) {
    shutdownInput();
    console.log(dim("cancelled"));
    return 0;
  }
  return execute(selection.tasks, selection.model);
}

type Selection = { tasks: TaskMeta[]; model: string | undefined };

/**
 * The three screens — task tree, model picker, run manifest — as one loop.
 * Esc/← back out one screen at a time; backing out of the very first
 * screen cancels the run. Enter on the manifest executes.
 */
async function driveFlow(tasks: TaskMeta[], models: ModelOption[]): Promise<Selection | null> {
  const taskTree = buildTaskTree(tasks);
  const expanded = new Set<string>();
  const checked = new Set<string>();
  let chosenTasks: TaskMeta[] | null = null;
  let model: string | undefined;

  const pickTasks = () =>
    pickTree(
      bold("Run an eval") + dim("   [→] open [←] close [space] check [enter] run"),
      taskTree,
      expanded,
      checked,
    );
  const pickModel = async () => {
    const view = resolveEnvView((chosenTasks ?? tasks)[0]!.path, process.env);
    const env = effectiveModelSource(view, undefined);
    const result = await pickTree(
      bold("Model") + dim("   [→] open [esc] back · type to filter"),
      buildModelTree(models, env ? `via ${env.varName}` : "no model set yet", models.length === 0),
      new Set<string>(),
      new Set<string>(),
      { single: true, filter: true, filterIdle: " type to filter · prices are $ in / $ out per 1M tokens" },
    );
    if (result.kind === "back") return false;
    const choice = result.value[0]!;
    if (choice.kind === "custom") model = await askText("model id", models[0]?.id ?? "");
    else if (choice.kind === "catalog") model = choice.id;
    else model = undefined; // keep what .env already selects
    return true;
  };

  let step: "tasks" | "model" | "manifest" = "tasks";
  while (true) {
    if (step === "tasks") {
      const result = await pickTasks();
      if (result.kind === "back") {
        if (chosenTasks === null) return null;
        step = "manifest"; // re-entry: back means "keep what I had"
        continue;
      }
      chosenTasks = result.value;
      step = "model";
      continue;
    }
    if (step === "model") {
      if (await pickModel()) step = "manifest";
      else step = "tasks";
      continue;
    }

    console.clear();
    const view = resolveEnvView(chosenTasks![0]!.path, process.env);
    console.log(`${bold("Ready to run")}\n`);
    console.log(manifestText(chosenTasks!, model, view));
    console.log(readinessLine(view, model));
    console.log(dim("\n[Enter] run · [d] env details · [b] model · [backspace] tasks"));
    const key = await waitKey();
    if (key.name === "d") {
      console.clear();
      console.log(`${bold("Environment details")}\n`);
      console.log(envDetailsText(view));
      console.log(dim("\n[any key] back"));
      await waitKey();
      continue;
    }
    if (key.name === "b" || key.name === "escape") {
      step = "model";
      continue;
    }
    if (key.name === "backspace") {
      step = "tasks";
      continue;
    }
    if (key.name === "return" || key.name === "enter") {
      return { tasks: chosenTasks!, model };
    }
  }
}

type ModelChoice =
  | { kind: "catalog"; id: string }
  | { kind: "custom" }
  | { kind: "default" };

function buildTaskTree(tasks: TaskMeta[]): TreeNode<TaskMeta>[] {
  const root: TreeNode<TaskMeta> = { name: "", key: "", children: [] };
  for (const t of tasks) {
    let node = root;
    for (const segment of (t.folderPath || "").split("/").filter(Boolean)) {
      node.children ??= [];
      let next = node.children.find((c) => c.children !== undefined && c.name === segment);
      if (!next) {
        next = { name: segment, key: node.key ? `${node.key}/${segment}` : segment, children: [] };
        node.children.push(next);
      }
      node = next;
    }
    node.children ??= [];
    node.children.push({ name: bareName(t.id), key: t.id, value: t, hint: checksHint(t) });
  }
  const finalize = (n: TreeNode<TaskMeta>): number => {
    if (n.value !== undefined || !n.children) return 1;
    n.children.sort((a, b) => {
      const af = a.children !== undefined ? 0 : 1;
      const bf = b.children !== undefined ? 0 : 1;
      return af - bf || a.name.localeCompare(b.name);
    });
    n.count = n.children.reduce((sum, c) => sum + finalize(c), 0);
    return n.count;
  };
  finalize(root);
  return root.children ?? [];
}

function buildModelTree(
  models: ModelOption[],
  envHint: string,
  emptyCatalog: boolean,
): TreeNode<ModelChoice>[] {
  const byProvider = new Map<string, ModelOption[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider);
    if (list) list.push(m);
    else byProvider.set(m.provider, [m]);
  }
  const roots: TreeNode<ModelChoice>[] = [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({
      name: provider,
      key: `provider/${provider}`,
      count: list.length,
      children: list.map((m) => ({
        name: m.display,
        key: `model/${m.id}`,
        value: { kind: "catalog", id: m.id } as ModelChoice,
        // The unit convention ($ in/$out per 1M) lives in the picker's idle
        // filter line, not on every row.
        hint: `$${m.input}/$${m.output}`,
      })),
    }));
  roots.push({ name: "✎ type a model id…", key: "custom", value: { kind: "custom" }, hint: "anything your provider accepts" });
  roots.push({ name: "keep the .env model", key: "default", value: { kind: "default" }, hint: envHint });
  if (emptyCatalog) {
    // Informational row: an empty folder, so Enter can't select it.
    roots.push({ name: "(catalog unavailable — backend reachable?)", key: "unavailable", children: [], count: 0 });
  }
  return roots;
}

/** One task → full detail; many → what varies (folder breakdown, totals,
 *  capped commands). Same compression the prototype converged on. */
function manifestText(tasks: TaskMeta[], model: string | undefined, view: EnvView): string {
  const env = effectiveModelSource(view, model);
  const modelLine =
    env?.from === "chosen" && env.model
      ? `${bold("model")}  ${cyan(env.model)}`
      : env?.from === "env"
        ? `${bold("model")}  ${dim(`from ${env.varName}`)}`
        : `${bold("model")}  ${red("none set")}`;

  if (tasks.length === 1) {
    const t = tasks[0]!;
    return [
      `${bold("task")}   ${t.id}`,
      t.description ? `${dim("what")}    ${t.description}` : "",
      modelLine,
      `${bold("judge")}  ${checksHint(t)}`,
      "",
      `  ${dim("$")} ${bold(`${model ? `OPENROUTER_MODEL='${model}' ` : ""}apo task run ${t.id}`)}`,
    ].filter((line) => line !== "").join("\n");
  }

  const byFolder = new Map<string, number>();
  for (const t of tasks) {
    const folder = t.folderPath || "(top)";
    byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
  }
  const breakdown = [...byFolder.entries()].map(([f, n]) => `${f} ${dim(`×${n}`)}`).join(dim("   "));
  const totalChecks = tasks.reduce((sum, t) => sum + t.checkCount, 0);
  const prefix = model ? `OPENROUTER_MODEL='${model}' ` : "";
  const commands = tasks.slice(0, 3).map((t) => `  ${dim("$")} ${bold(`${prefix}apo task run ${t.id}`)}`);
  const hidden = tasks.length - 3;
  return [
    `${bold("tasks")}  ${tasks.length} selected`,
    `        ${breakdown}`,
    modelLine,
    `${bold("judge")}  ${totalChecks} checks total`,
    "",
    ...commands,
    hidden > 0 ? `  ${dim(`… +${hidden} more the same shape`)}` : "",
  ].filter((line) => line !== "").join("\n");
}

/** One plain go/no-go line: green says what passed, red says the fix. */
function readinessLine(view: EnvView, model: string | undefined): string {
  const modelOk = model !== undefined || effectiveModelSource(view, undefined) !== null;
  const keyOk = hasProviderKey(view);
  if (modelOk && keyOk) return green("✓ ready to run — model and API key found");
  if (!modelOk) return red("✗ no model selected — press [b] and pick one");
  return red("✗ no API key found — add OPENROUTER_API_KEY or OPENAI_API_KEY to a .env file, then come back");
}

/** The diagnose-on-demand audit behind [d]. */
function envDetailsText(view: EnvView): string {
  const CHAIN_LABELS = ["task .env", "tasks/.env", "backend/.env", "example-service/.env", "repo .env"];
  const chain = view.files
    .map((f, i) => {
      const label = CHAIN_LABELS[i] ?? f.path;
      return f.exists ? `${green("✓")} ${label}` : `${dim("·")} ${dim(label)} ${dim("missing")}`;
    })
    .join("\n  ");
  const rows = view.known.map((v) => [
    v.name,
    dim(v.meaning),
    v.set && v.source
      ? green(`set · ${v.source === "process env" ? "process env" : shortPath(v.source)}`)
      : dim("—"),
  ]);
  const parts = [
    `${bold(".env chain")} ${dim("(first wins, never overrides process env)")}\n  ${chain}`,
    formatTable(["var", "what it does", "state"], rows),
  ];
  if (view.others.length > 0) {
    parts.push(
      `${bold("other vars your .env provides")} ${dim("(names only — values never shown)")}\n  ${view.others.slice(0, 8).join(dim(", "))}${view.others.length > 8 ? dim(` … +${view.others.length - 8} more`) : ""}`,
    );
  }
  return parts.join("\n\n");
}

/** Run each selected task through `task run`'s machinery, sequentially,
 *  with the chosen model pinned via OPENROUTER_MODEL. Exit contract is
 *  task run's: 0 all passed, 1 any failed, 2 any errored. */
async function execute(tasks: TaskMeta[], model: string | undefined): Promise<number> {
  shutdownInput();
  console.clear();
  if (model) process.env.OPENROUTER_MODEL = model;

  const results: { task: TaskMeta; code: number }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    console.log(bold(`\n[${i + 1}/${tasks.length}] ${t.id}`) + dim(" — running…"));
    results.push({ task: t, code: await runTaskCommand([t.id]) });
  }

  console.log(`\n${bold("Results")}`);
  for (const r of results) {
    const verdict = r.code === 0 ? passFail(true) : r.code === 1 ? passFail(false) : red("ERROR");
    console.log(`  ${verdict}  ${r.task.id}`);
  }
  if (results.some((r) => r.code === 2)) return 2;
  if (results.some((r) => r.code === 1)) return 1;
  return 0;
}

function checksHint(t: TaskMeta): string {
  if (t.checkCount > 0) return `${t.checkCount} check${t.checkCount === 1 ? "" : "s"}`;
  if (t.hasChecks) return "checks ✓";
  return "run-only";
}

function bareName(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash < 0 ? id : id.slice(slash + 1);
}

function shortPath(path: string): string {
  return path.replace(`${process.cwd()}/`, "").replace(process.env.HOME ?? "", "~");
}
