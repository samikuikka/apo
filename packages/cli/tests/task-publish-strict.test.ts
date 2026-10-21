import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run as runTaskPublish } from "../src/commands/task-publish.ts";

/**
 * `--strict-removal` is the CI tripwire over the publish diff: a removal
 * that takes runs or schedules with it exits 1. Pair with `--dry-run` to
 * gate BEFORE anything is published; the dry-run delta comes from a
 * read-only catalog fetch and reports runs (schedules are server-side
 * knowledge, named by the real publish). Exit 1, not 2 — the command
 * worked, the gate said no.
 */

const PUBLISH_RESPONSE = {
  project: "proj-strict",
  schema_version: 2,
  task_count: 1,
  catalog_digest: "sha256:abc",
  published_at: "2026-10-21T12:00:00+00:00",
  execution_mode: "caller",
  diff: { added: [], removed: [], possible_renames: [] },
};

function writeTree(root: string): void {
  const taskDir = join(root, "chat", "alpha");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "alpha.eval.ts"),
    'import { task } from "@apo-ai/sdk/agent-task";\ntask("alpha", { adapter: "a" });\n',
  );
}

describe("task publish — strict-removal gate", () => {
  let root: string;
  let lines: string[];
  let errLines: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  let fetchImpl: ((url: unknown, init?: RequestInit) => Promise<Response>) | null;

  beforeEach(() => {
    process.env.APO_PROJECT_ID = "proj-strict";
    process.env.APO_BACKEND_URL = "http://localhost:8100";
    root = mkdtempSync(join(tmpdir(), "apo-publish-strict-"));
    writeTree(root);
    lines = [];
    errLines = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => errLines.push(args.map(String).join(" "));
    fetchImpl = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (fetchImpl) return fetchImpl(url, init);
      return new Response(JSON.stringify(PUBLISH_RESPONSE), { status: 200 });
    });
  });

  afterEach(() => {
    delete process.env.APO_PROJECT_ID;
    delete process.env.APO_BACKEND_URL;
    rmSync(root, { recursive: true, force: true });
    console.log = origLog;
    console.error = origErr;
    vi.restoreAllMocks();
  });

  function catalogResponse(summaries: Array<{ id: string; total_runs: number }>): Response {
    return new Response(
      JSON.stringify(
        summaries.map((s) => ({
          id: s.id,
          task_path: s.id,
          folder_path: s.id.split("/")[0] ?? "",
          display_name: s.id.split("/").pop(),
          adapter_name: "cli",
          has_checks: true,
          tags: [],
          run_stats: { total_runs: s.total_runs },
        })),
      ),
      { status: 200 },
    );
  }

  it("live publish exits 1 when a removal keeps runs", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...PUBLISH_RESPONSE,
            diff: {
              added: [],
              removed: [
                { task_id: "chat/beta", display_name: "beta", run_count: 3, schedules: [] },
              ],
              possible_renames: [],
            },
          }),
          { status: 200 },
        ),
      );

    const code = await runTaskPublish(["--dir", root, "--strict-removal"]);

    expect(code).toBe(1);
    const err = errLines.join("\n");
    expect(err).toContain("strict-removal: chat/beta was removed with 3 retained runs");
    expect(err).toContain("--strict-removal gate failed");
  });

  it("live publish exits 1 naming a referencing schedule", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...PUBLISH_RESPONSE,
            diff: {
              added: [],
              removed: [
                { task_id: "ops/check", display_name: "check", run_count: 0, schedules: ["nightly"] },
              ],
              possible_renames: [],
            },
          }),
          { status: 200 },
        ),
      );

    const code = await runTaskPublish(["--dir", root, "--strict-removal"]);

    expect(code).toBe(1);
    expect(errLines.join("\n")).toContain('schedule "nightly"');
  });

  it("silent removals (no runs, no schedules) pass the gate", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ...PUBLISH_RESPONSE,
            diff: {
              added: [],
              removed: [
                { task_id: "chat/beta", display_name: "beta", run_count: 0, schedules: [] },
              ],
              possible_renames: [],
            },
          }),
          { status: 200 },
        ),
      );

    const code = await runTaskPublish(["--dir", root, "--strict-removal"]);

    expect(code).toBe(0);
    expect(errLines.join("\n")).not.toContain("strict-removal:");
  });

  it("dry-run prints the delta and gates on it without publishing", async () => {
    // The tree holds only chat/alpha; the server catalog also has chat/beta
    // with 2 runs and chat/gone with 0.
    fetchImpl = () => Promise.resolve(catalogResponse([
      { id: "chat/alpha", total_runs: 0 },
      { id: "chat/beta", total_runs: 2 },
      { id: "chat/gone", total_runs: 0 },
    ]));

    const code = await runTaskPublish(["--dir", root, "--dry-run", "--strict-removal"]);

    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("would remove  chat/beta");
    expect(out).toContain("2 runs would be archived with it");
    expect(out).toContain("would remove  chat/gone");
    expect(out).toContain("No catalog change sent");
    const err = errLines.join("\n");
    expect(err).toContain("strict-removal: chat/beta would be removed with 2 retained runs");
    // Only the blocking removal is gated, not the silent one.
    expect(err).not.toContain("chat/gone would be removed");
  });

  it("dry-run without strict exits 0 and still shows the delta", async () => {
    fetchImpl = () => Promise.resolve(catalogResponse([
      { id: "chat/alpha", total_runs: 0 },
      { id: "chat/beta", total_runs: 2 },
    ]));

    const code = await runTaskPublish(["--dir", root, "--dry-run"]);

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("would remove  chat/beta");
  });

  it("dry-run survives an unreadable catalog (delta skipped, gate not failed)", async () => {
    fetchImpl = () => Promise.resolve(new Response("{}", { status: 404 }));

    const code = await runTaskPublish(["--dir", root, "--dry-run", "--strict-removal"]);

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("delta not shown");
    expect(errLines.join("\n")).not.toContain("gate failed");
  });

  it("dry-run --json stays a pure local print (no fetch, no delta)", async () => {
    const code = await runTaskPublish(["--dir", root, "--dry-run", "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { tasks: Array<{ task_id: string }> };
    expect(parsed.tasks.map((t) => t.task_id)).toEqual(["chat/alpha"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses --dry-run --json --strict-removal instead of passing silently", async () => {
    const code = await runTaskPublish(["--dir", root, "--dry-run", "--json", "--strict-removal"]);

    expect(code).toBe(2);
    expect(errLines.join("\n")).toContain("needs the catalog delta");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("strict with a failed publish stays exit 2, no gate output", async () => {
    fetchImpl = () => Promise.resolve(new Response("boom", { status: 500 }));

    const code = await runTaskPublish(["--dir", root, "--strict-removal"]);

    expect(code).toBe(2);
    expect(errLines.join("\n")).not.toContain("strict-removal:");
  });

  it("allow-empty dry-run gates removal of the whole catalog", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "apo-publish-empty-"));
    try {
      fetchImpl = () => Promise.resolve(catalogResponse([{ id: "chat/alpha", total_runs: 2 }]));

      const code = await runTaskPublish(["--dir", emptyRoot, "--allow-empty", "--dry-run", "--strict-removal"]);

      expect(code).toBe(1);
      const out = lines.join("\n");
      expect(out).toContain("would remove  chat/alpha");
      expect(errLines.join("\n")).toContain("strict-removal: chat/alpha would be removed with 2 retained runs");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it("tasks with null run_stats count as zero runs", async () => {
    fetchImpl = () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              id: "chat/beta",
              task_path: "chat/beta",
              folder_path: "chat",
              display_name: "beta",
              adapter_name: "cli",
              has_checks: true,
              tags: [],
              run_stats: null,
            },
          ]),
          { status: 200 },
        ),
      );

    const code = await runTaskPublish(["--dir", root, "--dry-run", "--strict-removal"]);

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("would remove  chat/beta");
    expect(out).not.toContain("runs would be archived");
  });

  it("a non-array catalog body degrades to delta-not-shown, gate not failed", async () => {
    fetchImpl = () => Promise.resolve(new Response(JSON.stringify({ removed: [] }), { status: 200 }));

    const code = await runTaskPublish(["--dir", root, "--dry-run", "--strict-removal"]);

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("delta not shown");
  });
});
