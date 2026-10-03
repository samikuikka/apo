#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const NPM_MANIFESTS = new Set([
  "packages/sdk/package.json",
  "packages/cli/package.json",
]);

export function isVersionOnlyManifestChange(beforeText, afterText) {
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return false;
  }

  if (typeof before.version !== "string" || typeof after.version !== "string") {
    return false;
  }
  if (before.version === after.version || !isSemver(after.version)) {
    return false;
  }

  before.version = "<version>";
  after.version = "<version>";
  return isDeepStrictEqual(before, after);
}

export function isVersionOnlyRelease(baseRevision, headRevision = "HEAD") {
  try {
    const changedFiles = git("diff", "--name-only", "--diff-filter=ACMR", baseRevision, headRevision)
      .split("\n")
      .filter(Boolean);
    if (changedFiles.length !== 1 || !NPM_MANIFESTS.has(changedFiles[0])) {
      return false;
    }

    const manifest = changedFiles[0];
    return isVersionOnlyManifestChange(
      git("show", `${baseRevision}:${manifest}`),
      git("show", `${headRevision}:${manifest}`),
    );
  } catch {
    return false;
  }
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function isSemver(value) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRevision = process.argv[2];
  const headRevision = process.argv[3] ?? "HEAD";
  if (!baseRevision) {
    console.error("usage: scripts/is-version-only-npm-release.mjs <base-revision> [head-revision]");
    process.exit(2);
  }
  console.log(isVersionOnlyRelease(baseRevision, headRevision) ? "true" : "false");
}
