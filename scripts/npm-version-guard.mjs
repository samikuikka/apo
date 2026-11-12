#!/usr/bin/env node
// Version-regression guard for npm packages.
//
// Fails when a package manifest's version is LOWER than the version already
// published on the npm registry. A version-only PR that rebases across
// concurrent releases can silently carry an older number than main (it
// happened: a 0.17.1 bump merged over 0.18.1 main, and only npm's own
// latest-tag rule caught it at publish time). package:check runs on every
// PR, so this stops a downgrade before merge.
//
// Unreachable registry or a package not yet published: pass with a note, so
// offline development and first releases are never blocked.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function publishedVersionIsHigher(local, published) {
  const a = parse(local);
  const b = parse(published);
  if (a === null || b === null) return false;
  if (a.major !== b.major) return a.major < b.major;
  if (a.minor !== b.minor) return a.minor < b.minor;
  if (a.patch !== b.patch) return a.patch < b.patch;
  // Equal release tuple: a prerelease of the same tuple is lower than the
  // release (1.0.0-rc.1 < 1.0.0), otherwise they are the same version.
  return a.pre !== null && b.pre === null;
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? null,
  };
}

export function assertVersionNotRegressed(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  let published;
  try {
    published = execFileSync(
      "npm",
      ["view", manifest.name, "version", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 },
    ).trim().replace(/^"|"$/g, "");
  } catch {
    console.error(`  • registry unreachable, version-regression guard skipped for ${manifest.name}`);
    return;
  }
  if (published === "" || published === "undefined") return;
  if (publishedVersionIsHigher(manifest.version, published)) {
    console.error(
      `\n  ✖ ${manifest.name} manifest version ${manifest.version} is LOWER than the published ${published}.` +
        `\n     Rebase over current main and bump from the published version.\n`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const pkgDir = process.argv[2];
  if (!pkgDir) {
    console.error("usage: node scripts/npm-version-guard.mjs <package-dir>");
    process.exit(2);
  }
  assertVersionNotRegressed(pkgDir);
}
