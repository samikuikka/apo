import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installApoSkill, MANAGED_MARKER } from "../src/lib/skill-install.ts";
import { SKILL_MD } from "../src/lib/skill-content.ts";

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "apo-skill-home-"));
}

function agentsSkillDir(home: string): string {
  return join(home, ".agents", "skills", "apo");
}

function claudeSkillDir(home: string): string {
  return join(home, ".claude", "skills", "apo");
}

describe("installApoSkill", () => {
  it("installs fresh into both agent-readable locations", () => {
    const home = freshHome();
    try {
      const results = installApoSkill(home);
      expect(results.map((r) => r.status)).toEqual(["installed", "installed"]);

      for (const dir of [agentsSkillDir(home), claudeSkillDir(home)]) {
        expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe(SKILL_MD);
        expect(existsSync(join(dir, MANAGED_MARKER))).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("replaces a previous CLI-managed install", () => {
    const home = freshHome();
    try {
      installApoSkill(home);
      // A stale file from an older skill version must not survive the update.
      writeFileSync(join(agentsSkillDir(home), "stale-reference.md"), "old", "utf-8");

      const results = installApoSkill(home);
      expect(results.map((r) => r.status)).toEqual(["replaced", "replaced"]);
      expect(existsSync(join(agentsSkillDir(home), "stale-reference.md"))).toBe(false);
      expect(readFileSync(join(agentsSkillDir(home), "SKILL.md"), "utf-8")).toBe(SKILL_MD);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves a hand-installed skill untouched", () => {
    const home = freshHome();
    try {
      const skillDir = agentsSkillDir(home);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: apo\n---\nhand-tuned\n", "utf-8");

      const results = installApoSkill(home);
      const agents = results.find((r) => r.dir === skillDir);
      expect(agents?.status).toBe("skipped-existing");
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("hand-tuned");

      // The other location is still served.
      const claude = results.find((r) => r.dir === claudeSkillDir(home));
      expect(claude?.status).toBe("installed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never deletes through a symlinked skill dir", () => {
    const home = freshHome();
    const target = mkdtempSync(join(tmpdir(), "apo-skill-dotfiles-"));
    try {
      // The symlink target looks fully CLI-managed — the symlink must still
      // shield it, because it may live in a dotfiles repo.
      mkdirSync(join(target, "apo"), { recursive: true });
      writeFileSync(join(target, "apo", "SKILL.md"), "dotfiles copy", "utf-8");
      writeFileSync(join(target, "apo", MANAGED_MARKER), "x", "utf-8");

      mkdirSync(join(home, ".agents", "skills"), { recursive: true });
      symlinkSync(join(target, "apo"), agentsSkillDir(home));

      const results = installApoSkill(home);
      const agents = results.find((r) => r.dir === agentsSkillDir(home));
      expect(agents?.status).toBe("skipped-existing");
      expect(readFileSync(join(target, "apo", "SKILL.md"), "utf-8")).toBe("dotfiles copy");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });
});
