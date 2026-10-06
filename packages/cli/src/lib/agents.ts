// Coding-agent registry and detection.
//
// `apo init` uses this to find which coding agents are installed (binary on
// PATH + config directory) and how to hand each one a kickoff prompt. The
// two-signal detection (PATH + config dir) comes from respan's setup wizard:
// a binary on PATH alone misses tools installed but never configured, and a
// config dir alone misses a fresh install whose PATH isn't visible to us.

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export type CliTool = "claude-code" | "cursor" | "codex-cli" | "gemini-cli" | "opencode";

export interface ToolMeta {
  name: string;
  binary: string;
  description: string;
  /** Dirs that indicate use of the tool — `~` entries resolve against the
   *  home directory, `.` entries against the project root. */
  configDirs: string[];
}

export const CLI_TOOLS: Record<CliTool, ToolMeta> = {
  "claude-code": {
    name: "Claude Code",
    binary: "claude",
    description: "Anthropic's coding agent",
    configDirs: ["~/.claude", ".claude"],
  },
  cursor: {
    name: "Cursor",
    binary: "cursor",
    description: "AI-powered code editor",
    configDirs: [".cursor"],
  },
  "codex-cli": {
    name: "Codex CLI",
    binary: "codex",
    description: "OpenAI's coding agent",
    configDirs: ["~/.codex", ".codex"],
  },
  "gemini-cli": {
    name: "Gemini CLI",
    binary: "gemini",
    description: "Google's coding agent",
    configDirs: ["~/.gemini", ".gemini"],
  },
  opencode: {
    name: "OpenCode",
    binary: "opencode",
    description: "Open-source coding agent",
    configDirs: [".opencode"],
  },
};

export interface DetectionSignal {
  tool: CliTool;
  onPath: boolean;
  hasConfigDir: boolean;
  reason: string;
}

export function isBinaryInstalled(binary: string): boolean {
  try {
    execSync(`command -v ${binary}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Per-tool detection across every agent in {@link CLI_TOOLS}. */
export function detectAgents(projectRoot: string, home: string): DetectionSignal[] {
  const signals: DetectionSignal[] = [];

  for (const [id, meta] of Object.entries(CLI_TOOLS)) {
    const onPath = isBinaryInstalled(meta.binary);
    const hasConfigDir = meta.configDirs.some((dir) => {
      const resolved = dir.startsWith("~")
        ? path.join(home, dir.slice(1))
        : dir.startsWith(".")
          ? path.join(projectRoot, dir)
          : dir;
      return fs.existsSync(resolved);
    });

    const reasons: string[] = [];
    if (onPath) reasons.push("binary on PATH");
    if (hasConfigDir) reasons.push("config directory found");

    signals.push({
      tool: id as CliTool,
      onPath,
      hasConfigDir,
      reason: reasons.length > 0 ? reasons.join(", ") : "not detected",
    });
  }

  return signals;
}

/**
 * argv for launching a tool with a kickoff prompt. Claude Code needs the
 * prompt behind `--permission-mode acceptEdits` so the spawned agent can
 * actually write files; Codex, Gemini, and OpenCode take it as a positional.
 * Cursor's agent chat takes prompts from the UI, not the CLI — it gets the
 * project directory and the caller prints a "type /apo" instruction instead.
 */
export function launchArgv(tool: CliTool, prompt: string): string[] {
  if (tool === "claude-code") return ["--permission-mode", "acceptEdits", prompt];
  if (tool === "cursor") return ["."];
  return [prompt];
}
