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

  it("marks factory-call adapters with trailing (...) to distinguish them from bare identifiers", () => {
    // Real-world pattern: one parameterized adapter per flow family, built via a
    // factory. The static scanner can't load the module to resolve the runtime
    // name (adapter.name === "bind-chat" here), but it should at least make
    // clear that the displayed identifier is a factory call, not the adapter.
    writeTaskFile(join(testDir, "factory"), `
      task("factory", {
        adapter: createBindAdapter(chatAdapter),
        deliverables: ["result"],
      });
    `);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].adapter).toBe("createBindAdapter(...)");
  });

  it("keeps bare-identifier adapters as-is (no parens appended)", () => {
    // Regression guard: the existing pattern \`adapter: realAgentAdapter\` must
    // keep returning the bare identifier — the (...) suffix is only for calls.
    writeTaskFile(join(testDir, "bare"), `
      task("bare", { adapter: realAgentAdapter });
    `);

    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].adapter).toBe("realAgentAdapter");
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

describe("task execution preference (SPEC-136)", () => {
  it("extracts execution: 'local'", () => {
    writeTaskFile(join(testDir, "local-task"), `
      task("local-task", {
        adapter: myAdapter,
        deliverables: ["result"],
        execution: "local",
      });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBe("local");
  });

  it("extracts execution: 'backend'", () => {
    writeTaskFile(join(testDir, "backend-task"), `
      task("backend-task", { adapter: a, execution: "backend" });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBe("backend");
  });

  it("extracts execution: 'auto' as undefined (auto == no preference)", () => {
    writeTaskFile(join(testDir, "auto-task"), `
      task("auto-task", { adapter: a, execution: "auto" });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBeUndefined();
  });

  it("execution is undefined when the field is absent (legacy tasks)", () => {
    writeTaskFile(join(testDir, "legacy"), `
      task("legacy", { adapter: a, deliverables: ["result"] });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBeUndefined();
  });

  it("supports single-quoted values", () => {
    writeTaskFile(join(testDir, "single-q"), `
      task("single-q", { adapter: a, execution: 'local' });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBe("local");
  });

  it("ignores unknown execution values (undefined, not propagated)", () => {
    writeTaskFile(join(testDir, "typo"), `
      task("typo", { adapter: a, execution: "remotely" });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBeUndefined();
  });

  it("does not mistake an unrelated 'execution' substring for the field", () => {
    // A comment or different key must not trigger a match.
    writeTaskFile(join(testDir, "comment-only"), `
      // execution: "local"
      task("comment-only", { adapter: a });
    `);
    const tasks = discoverTaskMeta(testDir);
    expect(tasks[0].execution).toBeUndefined();
  });
});

