import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { firstCommitForFile, readGitProvenance, sanitizeGitUrl, buildCallerIdentity } from "../src/lib/git-provenance.ts";

/**
 * Git provenance for the caller attestation. Shells out to git (never
 * env-only), sanitizes credentials out of the remote URL, and reports dirty
 * state honestly.
 */

describe("git-provenance", () => {
  it("sanitizeGitUrl strips user-info and query credentials", () => {
    expect(sanitizeGitUrl("https://user:pass@github.com/acme/service.git"))
      .toBe("https://github.com/acme/service.git");
    expect(sanitizeGitUrl("https://github.com/acme/service.git?token=secret"))
      .toBe("https://github.com/acme/service.git");
    expect(sanitizeGitUrl("ssh://git@github.com/acme/service.git"))
      .toBe("https://github.com/acme/service.git".replace("https://github.com/acme/service.git", "ssh://github.com/acme/service.git"));
    expect(sanitizeGitUrl(null)).toBeNull();
  });

  describe("against a real temp git repo", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "apo-git-prov-"));
      execSync("git init -q", { cwd: dir });
      execSync('git config user.email "t@t"', { cwd: dir });
      execSync('git config user.name "t"', { cwd: dir });
      execSync("git remote add origin https://user:token@github.com/acme/service.git", { cwd: dir });
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("reads commit, sanitized remote, and clean state after commit", () => {
      writeFileSync(join(dir, "a.txt"), "hi");
      execSync("git add . && git commit -qm c1", { cwd: dir });
      const prov = readGitProvenance(dir);
      expect(prov.repositoryUrl).toBe("https://github.com/acme/service.git");
      expect(prov.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(prov.dirty).toBe(false);
    });

    it("reports dirty when there are uncommitted changes", () => {
      writeFileSync(join(dir, "a.txt"), "hi");
      execSync("git add . && git commit -qm c1", { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "changed");
      const prov = readGitProvenance(dir);
      expect(prov.dirty).toBe(true);
      // base commit is still the last committed HEAD
      expect(prov.baseCommitSha).toMatch(/^[0-9a-f]{40}$/);
    });

    it("firstCommitForFile returns the ADDING commit, not later edits", () => {
      // Author A adds the eval; author B later rewrites it. The catalog's
      // "who added this task" is A (issue #444) — even after the file was
      // amended by someone else.
      execSync('git config user.email "author-a@t" && git config user.name "Author A"', { cwd: dir });
      writeFileSync(join(dir, "alpha.eval.ts"), "task('alpha', {});\n");
      execSync("git add . && git commit -qm add-eval", { cwd: dir });
      execSync('git config user.email "author-b@t" && git config user.name "Author B"', { cwd: dir });
      writeFileSync(join(dir, "alpha.eval.ts"), "task('alpha', { maxTurns: 2 });\n");
      execSync("git add . && git commit -qm edit-eval", { cwd: dir });

      const first = firstCommitForFile(join(dir, "alpha.eval.ts"));
      expect(first).not.toBeNull();
      expect(first!.authorName).toBe("Author A");
      expect(first!.authorEmail).toBe("author-a@t");
      expect(first!.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(first!.sha).toMatch(/^[0-9a-f]{40}$/);
      // The sha is the ADDING commit, not HEAD.
      const head = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
      expect(first!.sha).not.toBe(head);
    });

    it("firstCommitForFile returns null for an untracked file", () => {
      writeFileSync(join(dir, "untracked.eval.ts"), "task('x', {});\n");
      expect(firstCommitForFile(join(dir, "untracked.eval.ts"))).toBeNull();
    });

    it("firstCommitForFile returns null outside a git repo", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "apo-nogit2-"));
      try {
        writeFileSync(join(nonGit, "alpha.eval.ts"), "task('alpha', {});\n");
        expect(firstCommitForFile(join(nonGit, "alpha.eval.ts"))).toBeNull();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns nulls outside a git repo", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "apo-nogit-"));
      try {
        const prov = readGitProvenance(nonGit);
        expect(prov.repositoryUrl).toBeNull();
        expect(prov.baseCommitSha).toBeNull();
        expect(prov.dirty).toBe(false);
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });

  it("buildCallerIdentity produces bounded allow-listed metadata (no raw hostname)", () => {
    const id = buildCallerIdentity({ clientVersion: "0.1.0", ciProvider: "github-actions" });
    expect(id.client).toBe("apo-cli");
    expect(id.client_version).toBe("0.1.0");
    expect(id.ci_provider).toBe("github-actions");
    expect(id.os).toBe(process.platform);
    expect(typeof id.hostname_hash).toBe("string");
    expect(id.hostname_hash === null || id.hostname_hash.length === 16).toBe(true);
  });
});
