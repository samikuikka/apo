import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import {
  listLocalTaskFiles,
  readLocalTaskFile,
} from "../src/lib/task-files.ts";

let testDir: string;

function writeTaskFile(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename(dir)}.eval.ts`), content);
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `apo-task-files-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("listLocalTaskFiles", () => {
  it("lists task source files and files/ directory entries", () => {
    const taskDir = join(testDir, "meeting-summary");
    writeTaskFile(
      taskDir,
      `export default defineTask(adapter, { id: "meeting-summary" });`,
    );
    writeFileSync(join(taskDir, "checks.ts"), "export {}");
    writeFileSync(join(taskDir, "user-simulator.ts"), "export {}");
    mkdirSync(join(taskDir, "files"), { recursive: true });
    writeFileSync(join(taskDir, "files", "instructions.md"), "# hi");

    const result = listLocalTaskFiles(testDir, "meeting-summary");
    const paths = result.files.map((file) => file.path);

    expect(paths).toContain("meeting-summary.eval.ts");
    expect(paths).toContain("checks.ts");
    expect(paths).toContain("user-simulator.ts");
    expect(paths).toContain("files");
    expect(paths).toContain("files/instructions.md");
  });
});

describe("readLocalTaskFile", () => {
  it("reads a task file with metadata", () => {
    const taskDir = join(testDir, "meeting-summary");
    writeTaskFile(
      taskDir,
      `export default defineTask(adapter, { id: "meeting-summary" });`,
    );
    writeFileSync(join(taskDir, "checks.ts"), "export const ok = true;\n");

    const result = readLocalTaskFile(testDir, "meeting-summary", "checks.ts");

    expect(result.path).toBe("checks.ts");
    expect(result.language).toBe("typescript");
    expect(result.content).toContain("ok = true");
    expect(result.lines).toBe(2);
  });

  it("throws when task file does not exist", () => {
    const taskDir = join(testDir, "meeting-summary");
    writeTaskFile(
      taskDir,
      `export default defineTask(adapter, { id: "meeting-summary" });`,
    );

    expect(() =>
      readLocalTaskFile(testDir, "meeting-summary", "missing.ts"),
    ).toThrow("File not found");
  });
});
