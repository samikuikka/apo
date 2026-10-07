/**
 * apo init — agent-driven onboarding.
 *
 * Installs the apo authoring skill for every coding agent on the machine,
 * then launches the user's agent with a kickoff prompt: write an adapter and
 * your first task for this repo. The CLI only detects, installs, and hands
 * over — the agent does the scaffolding against the real repository, which
 * beats any template the CLI could embed.
 */

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { getBoolFlag, getFlagValue, parseArgs } from "../lib/args.ts";
import { readCredentials } from "../lib/credentials.ts";
import { pickOption, type PickerOption } from "../lib/picker.ts";
import { bold, cyan, dim, green, red } from "../lib/format.ts";
import {
  CLI_TOOLS,
  type CliTool,
  detectAgents,
  isBinaryInstalled,
  launchArgv,
} from "../lib/agents.ts";
import { installApoSkill } from "../lib/skill-install.ts";

const KICKOFF_PROMPT = [
  "Set up apo in this repository.",
  "You have the apo skill installed — use the /apo command if available, otherwise read SKILL.md under ~/.agents/skills/apo (or ~/.claude/skills/apo).",
  "Steps:",
  "1. Explore this repo and pick the agent or LLM feature to test (an agent function, an LLM call, a CLI agent).",
  "2. Write an apo adapter bridging it (defineAdapter from @apo-ai/sdk/agent-task).",
  "3. Define one capability task as a *.eval.ts file with checks and a files/ input directory.",
  "4. npm install @apo-ai/sdk if missing, then `apo task publish --dir <task-root>`.",
  "5. `apo task run <task-id>`, read the verdict with `apo runs show <run-id>`, and iterate on the adapter or agent until PASS.",
  "Never edit the task to make a run pass — the task defines correct behavior; fix the agent instead.",
  "If `apo login` has not been run in this environment, stop and tell the user to run it first.",
].join("\n");

const CURSOR_INSTRUCTION =
  "In Cursor's agent chat, type /apo and ask it to set up apo in this repo — write an adapter and your first task.";

/** Injectable seams so tests never touch the real $HOME or cwd. */
export interface InitDeps {
  home?: string;
  projectRoot?: string;
}

export async function run(argv: string[], deps: InitDeps = {}): Promise<number> {
  const { flags } = parseArgs(argv);
  const noLaunch = getBoolFlag(flags, "no-launch");
  const agentFlag = getFlagValue(flags, "agent");

  if (agentFlag && !(agentFlag in CLI_TOOLS)) {
    console.error(
      red(
        `Unknown agent '${agentFlag}'. Valid: ${Object.keys(CLI_TOOLS).join(", ")}.`,
      ),
    );
    return 1;
  }

  const home = deps.home ?? homedir();
  const projectRoot = deps.projectRoot ?? process.cwd();

  console.log(bold("apo init — set up this repo for agent-driven testing"));
  console.log(dim(`Project root: ${projectRoot}`));
  console.log("");

  if (!readCredentials()) {
    console.log(
      dim("Not logged in. The skill still installs, but the launched agent needs `apo login` before it can publish or run tasks."),
    );
    console.log("");
  }

  // ── Detect ─────────────────────────────────────────────────────────────
  const detected = detectAgents(projectRoot, home);
  const detectedTools = detected.filter((d) => d.onPath || d.hasConfigDir);

  for (const signal of detected) {
    const meta = CLI_TOOLS[signal.tool];
    const mark = signal.onPath || signal.hasConfigDir ? green("✓") : dim("·");
    console.log(`  ${mark} ${meta.name.padEnd(12)} ${dim(signal.reason)}`);
  }
  console.log("");

  // ── Select ─────────────────────────────────────────────────────────────
  let selected: CliTool | null = null;
  let explicitlyFlagged = false;

  if (!noLaunch) {
    if (agentFlag) {
      selected = agentFlag as CliTool;
      explicitlyFlagged = true;
    } else {
      const options: PickerOption<CliTool | "none">[] = [
        ...detectedTools.map((d) => ({
          label: `${CLI_TOOLS[d.tool].name} — ${CLI_TOOLS[d.tool].description} (detected)`,
          value: d.tool as CliTool | "none",
        })),
        ...detected
          .filter((d) => !(d.onPath || d.hasConfigDir))
          .map((d) => ({
            label: `${CLI_TOOLS[d.tool].name} — ${CLI_TOOLS[d.tool].description} (not detected)`,
            value: d.tool as CliTool | "none",
          })),
        { label: "None — install the skill only", value: "none" as const },
      ];
      // Headless runs land on the single detected agent when there is one —
      // but they never spawn it (see the launch gate below); only an explicit
      // --agent confirms a spawn without a terminal. With nothing detected
      // the default is "None": "Claude Code (default)" on an agent-less
      // machine would be a recommendation to install an agent, not a
      // detection.
      const defaultIndex = detectedTools.length > 0 ? 0 : options.length - 1;
      const picked = await pickOption("Open which coding agent?", options, defaultIndex);
      selected = picked === "none" ? null : picked;
    }
  }

  // ── Install ────────────────────────────────────────────────────────────
  const results = installApoSkill(home);
  let failed = false;
  for (const result of results) {
    if (result.status === "failed") {
      failed = true;
      console.error(red(`  ✗ ${result.dir} — ${result.detail}`));
      continue;
    }
    const mark =
      result.status === "skipped-existing" ? dim("•") : green("✓");
    console.log(`  ${mark} ${result.dir}`);
    console.log(dim(`    ${result.detail}`));
  }
  console.log("");

  if (failed) return 1;

  // ── Launch ─────────────────────────────────────────────────────────────
  if (selected) {
    const meta = CLI_TOOLS[selected];

    if (!isBinaryInstalled(meta.binary)) {
      console.log(
        dim(`${meta.binary} is not on PATH. Install it; it will pick up the skill on its own.`),
      );
    } else {
      let launch = true;
      if (stdin.isTTY) {
        const rl = createInterface({ input: stdin, output: stdout });
        const answer = (
          await rl.question(`Open ${meta.name} now and have it write your first task? [Y/n] `)
        ).trim().toLowerCase();
        rl.close();
        launch = answer === "" || answer === "y" || answer === "yes";
      } else if (!explicitlyFlagged) {
        // Headless picker default — spawning an interactive agent into a
        // pipe would hang. Tell the user how to launch for real.
        console.log(
          dim(`Selected ${meta.name} (default, no terminal to confirm). Run apo init --agent ${selected} to launch it.`),
        );
        launch = false;
      }

      if (launch) {
        console.log(cyan(`Opening ${meta.name}...`));
        console.log("");
        if (selected === "cursor") {
          console.log(dim(CURSOR_INSTRUCTION));
          console.log("");
        }
        spawnSync(meta.binary, launchArgv(selected, KICKOFF_PROMPT), {
          stdio: "inherit",
          cwd: projectRoot,
        });
        // The agent's own exit status is not init's — the skill is installed
        // and the kickoff was delivered; what the agent does with it is the
        // user's session.
      }
    }
  }

  console.log("");
  console.log(bold("Next steps"));
  console.log(`  ${dim("The launched agent writes an adapter + first task, publishes, and runs it.")}`);
  console.log(`  ${dim("After it publishes: apo task list, then apo task run <task-id>.")}`);
  console.log(`  ${dim("Docs: https://docs.test-apo.online")}`);
  return 0;
}
