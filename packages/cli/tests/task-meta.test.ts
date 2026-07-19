import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import {
  discoverTaskMeta,
  findTaskMetaById,
} from "../src/lib/task-meta.ts";

let testDir: string;

function writeTaskFile(dir: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${basename(dir)}.eval.ts`), content);
}

beforeEach(() => {
  testDir = join(tmpdir(), `apo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("discoverTaskMeta", () => {
  it("discovers tasks in subdirectories", () => {
    writeTaskFile(join(testDir, "task-a"), `
      const task = defineTask(MyAdapter, {
        id: "task-a",
        adapter: "my-adapter",
        deliverables: ["summary", "stats"],
      });
    `);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-a");
    expect(tasks[0].adapter).toBe("my-adapter");
    expect(tasks[0].deliverables).toEqual(["summary", "stats"]);
  });

  it("discovers tasks in nested directories", () => {
    writeTaskFile(join(testDir, "group", "task-b"), `
      const task = {
        id: 'task-b',
        adapter: 'other',
      };
    `);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-b");
  });

  it("discovers multiple tasks", () => {
    writeTaskFile(join(testDir, "a"), `const t = { id: "a", adapter: "x" };`);
    writeTaskFile(join(testDir, "b"), `const t = { id: "b", adapter: "y" };`);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("returns empty array for directory with no tasks", () => {
    mkdirSync(join(testDir, "empty"), { recursive: true });
    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toEqual([]);
  });

  it("throws for nonexistent directory", () => {
    expect(() => discoverTaskMeta("/nonexistent/path")).toThrow(
      "Task directory not found",
    );
  });

  it("skips tasks without an id", () => {
    writeTaskFile(join(testDir, "bad"), `const t = { adapter: "x" };`);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toEqual([]);
  });

  it("detects checks.ts presence", () => {
    const taskDir = join(testDir, "with-checks");
    writeTaskFile(taskDir, `const t = { id: "with-checks" };`);
    writeFileSync(join(taskDir, "checks.ts"), "// checks");

    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].hasChecks).toBe(true);
  });

  it("discovers a single-file task with inline checks", () => {
    writeTaskFile(join(testDir, "single-file"), `
      task("single-file", {
        adapter: myAdapter,
        deliverables: ["result"],
      });
      const check = test<{ result: string }>;
      check("has-result", (t, { deliverables }) => {
        t.assert(Boolean(deliverables.result));
      });
    `);

    const tasks = discoverTaskMeta(testDir);

    expect(tasks).toMatchObject([
      {
        id: "single-file",
        adapter: "myAdapter",
        deliverables: ["result"],
        hasChecks: true,
      },
    ]);
  });

  it("detects simulator in task content", () => {
    writeTaskFile(join(testDir, "sim"), `
      const t = { id: "sim", simulator: mySimulator };
    `);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].hasSimulator).toBe(true);
  });

  it("lists files in files/ subdirectory", () => {
    const taskDir = join(testDir, "files-task");
    writeTaskFile(taskDir, `const t = { id: "files-task" };`);
    const filesDir = join(taskDir, "files");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "doc1.txt"), "");
    writeFileSync(join(filesDir, "doc2.txt"), "");

    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].files).toEqual(["doc1.txt", "doc2.txt"]);
  });

  it("extracts adapter from defineTask call when adapter field missing", () => {
    writeTaskFile(join(testDir, "deftask"), `
      const task = defineTask(MyAdapter, { id: "deftask" });
    `);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].adapter).toBe("MyAdapter");
  });

  it("defaults adapter to unknown when no match", () => {
    writeTaskFile(join(testDir, "no-adapter"), `const t = { id: "no-adapter" };`);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].adapter).toBe("unknown");
  });

  it("skips node_modules directories", () => {
    writeTaskFile(join(testDir, "valid"), `const t = { id: "valid", adapter: "x" };`);
    writeTaskFile(join(testDir, "node_modules", "pkg", "bad"), `const t = { id: "bad", adapter: "x" };`);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("valid");
  });

  it("skips hidden directories", () => {
    writeTaskFile(join(testDir, "visible"), `const t = { id: "visible", adapter: "x" };`);
    writeTaskFile(join(testDir, ".hidden", "bad"), `const t = { id: "bad", adapter: "x" };`);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("visible");
  });

  it("skips symlink directories by default", () => {
    try {
      lstatSync(testDir).isDirectory();
    } catch {
      return;
    }

    const targetDir = join(testDir, "target");
    const linkDir = join(testDir, "link");
    writeTaskFile(targetDir, `const t = { id: "target", adapter: "x" };`);

    try {
      symlinkSync(targetDir, linkDir);
    } catch {
      return;
    }

    writeTaskFile(join(linkDir, "linked-bad"), `const t = { id: "linked-bad", adapter: "x" };`);

    const tasks = discoverTaskMeta(testDir);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(["target"]);
  });

  it("reports errors via onError instead of throwing for unreadable directories", () => {
    const unreadable = join(testDir, "unreadable");
    mkdirSync(unreadable, { recursive: true });
    writeTaskFile(join(testDir, "ok"), `const t = { id: "ok", adapter: "x" };`);

    const errors: Array<{ path: string; error: unknown }> = [];
    discoverTaskMeta(testDir, {
      onError: (path, error) => errors.push({ path, error }),
    });

    expect(errors).toHaveLength(0);
  });
});

describe("findTaskMetaById", () => {
  it("finds task by id", () => {
    writeTaskFile(join(testDir, "target"), `const t = { id: "target", adapter: "x" };`);
    writeTaskFile(join(testDir, "other"), `const t = { id: "other", adapter: "y" };`);

    const task = findTaskMetaById(testDir, "target");
    expect(task).toBeDefined();
    expect(task?.id).toBe("target");
  });

  it("returns undefined for missing id", () => {
    writeTaskFile(join(testDir, "a"), `const t = { id: "a", adapter: "x" };`);

    const task = findTaskMetaById(testDir, "nonexistent");
    expect(task).toBeUndefined();
  });
});
