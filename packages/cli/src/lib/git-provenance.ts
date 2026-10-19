/**
 * caller workspace Git provenance for the CallerSourceAttestation.
 *
 * Shells out to `git` (never trusts env-only hints) for the base commit, the
 * sanitized remote URL (user-info/tokens stripped), and dirty state. Missing
 * git / not-a-repo yields nulls rather than throwing — the attestation still
 * records an honest "untracked local worktree" identity.
 */

import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

export interface GitProvenance {
  repositoryUrl: string | null;
  baseCommitSha: string | null;
  dirty: boolean;
}

export function readGitProvenance(cwd: string): GitProvenance {
  return {
    repositoryUrl: gitRemoteOrigin(cwd),
    baseCommitSha: gitHeadSha(cwd),
    dirty: gitIsDirty(cwd),
  };
}

/** Drop user-info and query credentials from a Git remote URL. */
export function sanitizeGitUrl(url: string | null): string | null {
  if (!url) return null;
  let cleaned = url.trim();
  // ssh: git@host:path  -> normalize nothing; no credentials to strip
  if (cleaned.includes("://")) {
    const schemeMatch = cleaned.match(/^([a-z]+):\/\/(.+)$/i);
    if (schemeMatch) {
      const [, scheme, rest] = schemeMatch;
      const withoutCreds = rest.includes("@") ? rest.split("@").slice(1).join("@") : rest;
      // Drop query-string credentials (e.g. ?token=).
      const pathOnly = withoutCreds.split("?")[0];
      cleaned = `${scheme}://${pathOnly}`;
    }
  }
  return cleaned;
}

function git(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim();
  } catch {
    return null;
  }
}

function gitRemoteOrigin(cwd: string): string | null {
  return sanitizeGitUrl(git(["remote", "get-url", "origin"], cwd));
}

export function gitHeadSha(cwd: string): string | null {
  const sha = git(["rev-parse", "HEAD"], cwd);
  if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
  return null;
}

function gitIsDirty(cwd: string): boolean {
  const status = git(["status", "--porcelain"], cwd);
  return status !== null && status.length > 0;
}

/** Who wrote a file, as far as git can tell: the commit that ADDED it. */
export interface FileFirstCommit {
  authorName: string;
  authorEmail: string;
  /** ISO-8601 author date, timezone included. */
  authorDate: string;
  sha: string;
}

/**
 * The adding commit of one file — the catalog's "who added this task"
 * (issue #444). Best-effort by design: a missing git, a non-repo task root,
 * a shallow clone cut before the addition, or any git error is a null, never
 * a throw — the server falls back to first-published when these are absent.
 * `--diff-filter=A --follow` lists adding commits newest-first, so the LAST
 * line is the original addition (a file moved later carries its earlier
 * history through the follow).
 */
export function firstCommitForFile(file: string): FileFirstCommit | null {
  const cwd = file.replace(/[/\\][^/\\]*$/, "") || ".";
  const out = git(
    ["log", "--diff-filter=A", "--follow", "--format=%an%x1f%ae%x1f%aI%x1f%H", "--", file],
    cwd,
  );
  if (!out) return null;
  const lines = out.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const [authorName = "", authorEmail = "", authorDate = "", sha = ""] =
    lines[lines.length - 1]!.split("\x1f");
  if (!authorName || !authorDate || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  return { authorName, authorEmail, authorDate, sha };
}

/** Bounded caller identity for the create-and-claim request (no raw hostname). */
export interface CallerIdentityInput {
  clientVersion: string;
  ciProvider?: string;
  ciJobId?: string;
  gitBranch?: string;
}

/** The full caller identity shape sent to the backend (bounded, allow-listed). */
export interface CallerIdentity {
  client: string;
  client_version: string;
  hostname_hash: string | null;
  ci_provider: string | null;
  ci_job_id: string | null;
  git_branch: string | null;
  os: string;
  architecture: string;
}

export function buildCallerIdentity(input: CallerIdentityInput): CallerIdentity {
  return {
    client: "apo-cli",
    client_version: input.clientVersion,
    hostname_hash: hashHostname(),
    ci_provider: input.ciProvider ?? null,
    ci_job_id: input.ciJobId ?? null,
    git_branch: input.gitBranch ?? null,
    os: process.platform,
    architecture: process.arch,
  };
}

/** SHA-256 of the hostname (first 16 hex chars) — never the raw hostname. */
function hashHostname(): string | null {
  try {
    const { createHash } = require("node:crypto") as {
      createHash: (a: string) => { update: (b: string) => { digest: (e: string) => string } };
    };
    return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}
