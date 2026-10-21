import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run as runTaskPublish } from "../src/commands/task-publish.ts";

/**
 * `apo task publish` reports the server's publish diff: removals
 * with their consequences (retained runs, referencing schedules), additions,
 * and probable moves. Warning-only, exit 0 — the catalog must converge with
 * git either way. The request also carries the best-effort working-tree HEAD
 * so removal tombstones can point into git history.
 */

const PUBLISH_RESPONSE = {
  project: "proj-report",
  schema_version: 2,
  task_count: 43,
  catalog_digest: "sha256:9f3ab2e1",
  published_at: "2026-10-18T12:00:00+00:00",
  execution_mode: "caller",
  diff: {
    added: ["harbor/terminal-bench/query-tcp-ports"],
    removed: [
      {
        task_id: "ai-sdk-agent/serving-integrity",
        display_name: "serving-integrity",
        run_count: 43,
        schedules: ["nightly"],
      },
    ],
    possible_renames: [
      {
        from: "(root)/t-jev-split",
        to: "(root)/t-jev-cascade",
        definition_sha256: "7c1e55c0ffee",
      },
    ],
  },
};

describe("task publish — removal report", () => {
  let root: string;
  let lines: string[];
  let origLog: typeof console.log;
  let requestBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    process.env.APO_PROJECT_ID = "proj-report";
    process.env.APO_BACKEND_URL = "http://localhost:8100";
    root = mkdtempSync(join(tmpdir(), "apo-publish-report-"));
    execSync("git init -q", { cwd: root });
    execSync('git config user.email "t@t" && git config user.name "T"', { cwd: root });
    const taskDir = join(root, "chat", "alpha");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "alpha.eval.ts"),
      'import { task } from "@apo-ai/sdk/agent-task";\ntask("alpha", { adapter: "a" });\n',
    );
    execSync("git add . && git commit -qm add-task", { cwd: root });

    lines = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    requestBody = undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(PUBLISH_RESPONSE), { status: 200 });
    });
  });

  afterEach(() => {
    delete process.env.APO_PROJECT_ID;
    delete process.env.APO_BACKEND_URL;
    rmSync(root, { recursive: true, force: true });
    console.log = origLog;
    vi.restoreAllMocks();
  });

  it("prints removals with consequences, additions, and moves — exit 0", async () => {
    const code = await runTaskPublish(["--dir", root]);

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("removed    ai-sdk-agent/serving-integrity");
    expect(out).toContain("43 runs retained — findable under Status \u25b8 Archived");
    expect(out).toMatch(/selected by schedule "nightly"/);
    expect(out).toContain("added      harbor/terminal-bench/query-tcp-ports");
    expect(out).toMatch(/moved\?     \(root\)\/t-jev-split \u2192 \(root\)\/t-jev-cascade/);
    expect(out).toContain("7c1e55c");
  });

  it("sends the working-tree HEAD as head_commit_sha", async () => {
    const code = await runTaskPublish(["--dir", root]);

    expect(code).toBe(0);
    const head = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
    expect(requestBody?.head_commit_sha).toBe(head);
  });

  it("prints nothing extra when the diff is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ...PUBLISH_RESPONSE, diff: { added: [], removed: [], possible_renames: [] } }),
        { status: 200 },
      ),
    );

    const code = await runTaskPublish(["--dir", root]);

    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toContain("removed ");
    expect(out).not.toContain("added ");
    expect(out).not.toContain("moved?");
  });

  it("--json passes the diff through untouched", async () => {
    const code = await runTaskPublish(["--dir", root, "--json"]);

    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as typeof PUBLISH_RESPONSE;
    expect(parsed.diff).toEqual(PUBLISH_RESPONSE.diff);
  });
});
