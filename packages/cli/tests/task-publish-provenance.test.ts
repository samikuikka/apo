import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run as runTaskPublish } from "../src/commands/task-publish.ts";
import { computeCatalogDigest } from "../src/lib/task-catalog-digest.ts";

/**
 * `apo task publish --dry-run` against a real temp git repo: the publication
 * carries the eval's declared description and the ADDING commit's authorship
 * (issue #444), and the digest stays over content metadata alone — provenance
 * availability can never move the digest `apo connect` claims gate on.
 */

describe("task publish — provenance fields", () => {
  let root: string;

  beforeEach(() => {
    // The command resolves the project from config; a dry run must not
    // depend on a local login existing.
    process.env.APO_PROJECT_ID = "proj-test";
    root = mkdtempSync(join(tmpdir(), "apo-publish-prov-"));
    execSync("git init -q", { cwd: root });
    execSync('git config user.email "author-a@t" && git config user.name "Author A"', { cwd: root });
    const taskDir = join(root, "chat", "alpha");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "alpha.eval.ts"),
      [
        'import { task } from "@apo-ai/sdk/agent-task";',
        "",
        "const { test } = task(\"alpha\", {",
        '  description: "Grades the Q3 summary against its work log.",',
        '  deliverables: ["report"],',
        "});",
        "",
        'test("figures-supported", async (t) => {',
        "  await t.check(t.deliverables.report, (v) => typeof v === \"string\");",
        "});",
        "",
      ].join("\n"),
    );
    execSync("git add . && git commit -qm add-task", { cwd: root });
  });
  afterEach(() => {
    delete process.env.APO_PROJECT_ID;
    rmSync(root, { recursive: true, force: true });
  });

  it("dry-run payload carries description and git authorship of the adding commit", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const code = await runTaskPublish([
        "--dry-run", "--json",
        "--dir", root,
        "--backend", "http://127.0.0.1:9", // never contacted in dry-run
      ]);
      expect(code).toBe(0);
    } finally {
      console.log = origLog;
    }

    const payload = JSON.parse(lines.join("\n")) as {
      tasks: Array<{
        task_id: string;
        description?: string;
        git_author_name?: string;
        git_first_commit_at?: string;
        git_first_commit_sha?: string;
      }>;
    };
    const alpha = payload.tasks.find((t) => t.task_id === "chat/alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.description).toBe("Grades the Q3 summary against its work log.");
    expect(alpha!.git_author_name).toBe("Author A");
    expect(alpha!.git_first_commit_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(alpha!.git_first_commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // Digest parity inside one publication: provenance and description are
    // not content — the CLI digest must equal itself with those fields dropped.
    const tasks = payload.tasks as Parameters<typeof computeCatalogDigest>[0];
    const stripped = tasks.map(({ description: _d, git_author_name: _n, git_author_email: _e, git_first_commit_at: _a, git_first_commit_sha: _s, ...rest }) => rest);
    expect(computeCatalogDigest(tasks)).toBe(computeCatalogDigest(stripped));
  });
});
