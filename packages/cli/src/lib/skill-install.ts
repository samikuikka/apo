// Skill installation for `apo init`.
//
// Writes the authoring skill (skill-content.ts) to every location coding
// agents read: ~/.agents/skills/ (Codex, Gemini, OpenCode, Cursor) and
// ~/.claude/skills/ (Claude Code reads only that one). Installs for ALL
// agents regardless of which one init launched — users switch tools.
//
// A directory is only ever wiped when it carries our managed marker. A
// hand-installed apo skill (or a symlink from a dotfiles repo) is reported
// and left untouched.

import * as fs from "node:fs";
import * as path from "node:path";
import { SKILL_MD } from "./skill-content.ts";

export const SKILL_DIR_NAME = "apo";
/** Dropped by the CLI next to SKILL.md; its presence makes a directory ours. */
export const MANAGED_MARKER = ".apo-cli-managed";

export type SkillInstallStatus = "installed" | "replaced" | "skipped-existing" | "failed";

export interface SkillLocationResult {
  dir: string;
  status: SkillInstallStatus;
  detail: string;
}

/** Relative skill locations under $HOME, keyed by which agents read them. */
const SKILL_BASE_DIRS: Array<{ dir: string[]; readers: string }> = [
  { dir: [".agents", "skills"], readers: "Codex, Gemini, OpenCode, Cursor" },
  { dir: [".claude", "skills"], readers: "Claude Code" },
];

function isManagedSkillDir(skillDir: string): boolean {
  try {
    return fs.existsSync(path.join(skillDir, MANAGED_MARKER));
  } catch {
    return false;
  }
}

function writeSkill(skillDir: string): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_MD, "utf-8");
  fs.writeFileSync(
    path.join(skillDir, MANAGED_MARKER),
    `installed by apo CLI at ${new Date().toISOString()}\n`,
    "utf-8",
  );
}

/** Install the skill into every agent-readable location under `home`. */
export function installApoSkill(home: string): SkillLocationResult[] {
  return SKILL_BASE_DIRS.map(({ dir, readers }) => {
    const skillDir = path.join(home, ...dir, SKILL_DIR_NAME);

    try {
      // Absent (lstat ENOENT) means a fresh install; every other shape needs
      // the no-destroy checks below.
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(skillDir);
      } catch {
        stat = undefined;
      }

      // A symlink is never ours to manage — it may point into a dotfiles
      // repo where rmSync would destroy the user's source of truth.
      if (stat?.isSymbolicLink()) {
        return {
          dir: skillDir,
          status: "skipped-existing",
          detail: `symlink — left untouched (${readers} will use it as-is)`,
        };
      }

      if (stat) {
        if (isManagedSkillDir(skillDir)) {
          // We own it: wipe so renamed/removed files never linger as orphans.
          fs.rmSync(skillDir, { recursive: true, force: true });
          writeSkill(skillDir);
          return {
            dir: skillDir,
            status: "replaced",
            detail: `updated (${readers})`,
          };
        }
        return {
          dir: skillDir,
          status: "skipped-existing",
          detail: `already exists and was not installed by the CLI — left untouched (${readers})`,
        };
      }

      writeSkill(skillDir);
      return {
        dir: skillDir,
        status: "installed",
        detail: `installed (${readers})`,
      };
    } catch (error) {
      return {
        dir: skillDir,
        status: "failed",
        detail: `write failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
