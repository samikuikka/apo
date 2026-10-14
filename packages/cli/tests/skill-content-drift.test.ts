import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_MD } from "../src/lib/skill-content.ts";

// The committed copy is the distribution artifact behind
// `npx skills add samikuikka/apo --skill apo`; the embedded string is what
// `apo init` installs. They must stay byte-identical so the public skill and
// the CLI-installed skill never teach different loops.

const committedSkillPath = fileURLToPath(
  new URL("../../../skills/apo/SKILL.md", import.meta.url),
);

describe("committed skill distribution copy", () => {
  it("is byte-identical to the SKILL_MD string the CLI installs", () => {
    expect(readFileSync(committedSkillPath, "utf8")).toBe(SKILL_MD);
  });
});
