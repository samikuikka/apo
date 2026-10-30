#!/usr/bin/env node
// @apo-ai/sdk clean-consumer package gate.
//
// Runs the full release-scene boundary against the package the registry
// would actually receive:
//
//   SDK source
//     -> tsup build (prepack)
//     -> pnpm pack + publishConfig rewrite
//     -> exact npm tarball
//     -> clean external npm install
//     -> Node ESM imports + TypeScript declarations
//     -> publint
//
// Never publishes. Never logs in. Always removes its temporary directory.
//
// Run with:
//   pnpm --filter @apo-ai/sdk package:check

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PKG_DIR, "..", "..");

const PUBLIC_EXPORTS = [
  "./otel",
  "./agent-task",
  "./agent-task/integrations/ai-sdk",
  "./agent-task/integrations/openai",
  "./agent-task/integrations/anthropic",
];

// ─── helpers ─────────────────────────────────────────────────────────────

function fail(message) {
  console.error(`\n  ✖ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function step(label) {
  console.log(`\n ▸ ${label}`);
}

function run(cmd, args, opts = {}) {
  const result = execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  return typeof result === "string" ? result.trim() : result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walkFiles(root) {
  /** Yield every file under `root`, depth-first, with absolute paths. */
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

function resolveExportTarget(pkgDir, target) {
  /** Resolve a "./dist/..." export target to an absolute installed path. */
  if (!target.startsWith("./")) return null;
  return join(pkgDir, target);
}

// ─── phases ──────────────────────────────────────────────────────────────

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "apo-sdk-verify-"));
  console.log(`  temp dir: ${dir}`);
  return dir;
}

function packSdk(tempDir) {
  step("Build + pack SDK tarball (prepack runs the build)");
  // `pnpm pack` is the only correct artifact source — it applies the
  // publishConfig rewrite (strips `development` conditions, locks the
  // five dist-only exports). Output path is printed by pnpm.
  const output = run("pnpm", ["pack", "--pack-destination", tempDir], {
    cwd: PKG_DIR,
  });
  const match = output.match(/([^\s]+\.tgz)\s*$/);
  if (!match) fail(`pnpm pack did not report a .tgz path:\n${output}`);
  const tarball = match[1];
  const absTarball = existsSync(tarball) ? tarball : join(tempDir, tarball);
  if (!existsSync(absTarball)) fail(`packed tarball not found: ${absTarball}`);

  const stat = statSync(absTarball);
  const sizeKb = Math.round(stat.size / 1024);
  console.log(`  tarball:      ${absTarball}`);
  console.log(`  compressed:   ${sizeKb} KB`);
  return { tarball: absTarball, sizeKb };
}

function installTarball(tempDir, tarball) {
  step("Install tarball into a clean npm consumer");
  const consumerDir = join(tempDir, "consumer");
  mkdirSync(consumerDir, { recursive: true });
  // Minimal real package.json so Node treats the dir as ESM. Save the SDK
  // and the test-only tools (typescript, publint) into this package.json so
  // NodeNext resolution can walk from consumer/ to find @apo-ai/sdk.
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "apo-sdk-consumer-smoke",
        private: true,
        type: "module",
        dependencies: {},
      },
      null,
      2,
    ) + "\n",
  );
  // --ignore-scripts: never run SDK lifecycle scripts in the consumer.
  // --no-audit --no-fund: keep CI quiet and offline-friendly.
  // Single install: SDK tarball + TypeScript + @types/node + publint. The
  // SDK's emitted .d.ts references Buffer and other Node globals, so a plain
  // NodeNext consumer needs @types/node just like any real Node TypeScript
  // app would. Splitting installs would make npm re-resolve and drop the
  // previous (no-save) tarball install.
  run(
    "npm",
    [
      "install",
      tarball,
      "typescript",
      "@types/node",
      "publint",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: consumerDir },
  );
  const installedPkgDir = join(consumerDir, "node_modules", "@apo-ai", "sdk");
  if (!existsSync(installedPkgDir)) {
    fail(`installed package missing at ${installedPkgDir}`);
  }
  console.log(`  installed:    ${installedPkgDir}`);
  return { consumerDir, installedPkgDir };
}

function verifyInstalledManifest(installedPkgDir, sourceManifest) {
  step("Verify installed package.json");
  const installed = readJson(join(installedPkgDir, "package.json"));

  if (installed.name !== sourceManifest.name) {
    fail(`name mismatch: installed=${installed.name} source=${sourceManifest.name}`);
  }
  if (installed.version !== sourceManifest.version) {
    fail(`version mismatch: installed=${installed.version} source=${sourceManifest.version}`);
  }
  console.log(`  name:         ${installed.name}`);
  console.log(`  version:      ${installed.version}`);

  const exportKeys = Object.keys(installed.exports ?? {}).sort();
  const expected = [...PUBLIC_EXPORTS].sort();
  if (JSON.stringify(exportKeys) !== JSON.stringify(expected)) {
    fail(`installed exports != expected\n  got:      ${exportKeys}\n  expected: ${expected}`);
  }

  // No development condition, no src/ target anywhere in the packed manifest.
  const serialized = JSON.stringify(installed);
  if (/("development"\s*:)/.test(serialized)) {
    fail("packed manifest exposes a `development` condition");
  }
  if (serialized.includes("/src/")) {
    fail("packed manifest points at a src/ target");
  }
  console.log(`  exports:      ${exportKeys.length} keys, no development, no src/`);
}

function verifyTargetsExist(installedPkgDir) {
  step("Verify every types/import/default target exists on disk");
  const installed = readJson(join(installedPkgDir, "package.json"));
  const exports = installed.exports ?? {};
  let checked = 0;
  for (const [name, conditions] of Object.entries(exports)) {
    for (const [cond, target] of Object.entries(conditions)) {
      if (typeof target !== "string" || !target.startsWith("./")) continue;
      const abs = resolveExportTarget(installedPkgDir, target);
      if (!abs || !existsSync(abs)) {
        fail(`missing target for ${name} / ${cond}: ${target}`);
      }
      checked += 1;
    }
  }
  console.log(`  checked:      ${checked} type/import/default targets`);
}

function verifyNoSourceShipped(installedPkgDir) {
  step("Verify no raw TypeScript source ships outside .d.ts");
  const files = walkFiles(installedPkgDir);
  const offenders = files.filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".d.cts") && !f.endsWith(".d.mts"),
  );
  if (offenders.length > 0) {
    fail(
      `raw .ts source shipped:\n  ${offenders.map((f) => relative(installedPkgDir, f)).join("\n  ")}`,
    );
  }
  const distFiles = files.filter((f) => f.includes(join("dist", " ")) || f.includes(`${join("dist")}/`));
  console.log(`  shipped:      ${files.length} files (${distFiles.length} under dist/)`);
  return { fileCount: files.length };
}

function verifyLicenseAndReadme(installedPkgDir) {
  step("Verify LICENSE + README");
  for (const name of ["LICENSE", "README.md"]) {
    const path = join(installedPkgDir, name);
    if (!existsSync(path)) fail(`missing ${name} in installed package`);
  }
  const rootLicense = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
  const installedLicense = readFileSync(join(installedPkgDir, "LICENSE"), "utf8");
  if (installedLicense.trim() !== rootLicense.trim()) {
    fail("installed LICENSE text does not match repository root LICENSE");
  }
  console.log("  LICENSE:      matches repository root");
  console.log("  README.md:    present");
}

function verifyNodeImports(installedPkgDir, consumerDir) {
  step("Node ESM import of all five entry points");
  // Write a tiny ESM module that imports every entry point under ordinary
  // Node resolution (no --conditions=development, no tsx).
  const probe = `
import { configureApoTelemetry, withApoTrace, score } from "@apo-ai/sdk/otel";
import { task, defineAdapter, runTask, includes, matches } from "@apo-ai/sdk/agent-task";
import { createApoTracer } from "@apo-ai/sdk/agent-task/integrations/ai-sdk";
import { createApoOpenAI } from "@apo-ai/sdk/agent-task/integrations/openai";
import { createApoAnthropic } from "@apo-ai/sdk/agent-task/integrations/anthropic";

if (typeof configureApoTelemetry !== "function") throw new Error("configureApoTelemetry not a function");
if (typeof withApoTrace !== "function") throw new Error("withApoTrace not a function");
if (typeof score !== "function") throw new Error("score not a function");
if (typeof task !== "function") throw new Error("task not a function");
if (typeof defineAdapter !== "function") throw new Error("defineAdapter not a function");
if (typeof runTask !== "function") throw new Error("runTask not a function");
if (typeof createApoTracer !== "function") throw new Error("createApoTracer not a function");
if (typeof createApoOpenAI !== "function") throw new Error("createApoOpenAI not a function");
if (typeof createApoAnthropic !== "function") throw new Error("createApoAnthropic not a function");

console.log(JSON.stringify({
  otel: true, agentTask: true,
  aiSdk: true, openai: true, anthropic: true,
}));
`;
  const probePath = join(consumerDir, "probe.mjs");
  writeFileSync(probePath, probe);
  try {
    const out = run("node", [probePath], { cwd: consumerDir });
    const parsed = JSON.parse(out);
    const entries = Object.keys(parsed).sort();
    const expected = ["aiSdk", "agentTask", "anthropic", "openai", "otel"].sort();
    if (JSON.stringify(entries) !== JSON.stringify(expected)) {
      fail(`probe returned wrong keys: ${entries.join(", ")}`);
    }
    const allTrue = Object.values(parsed).every((v) => v === true);
    if (!allTrue) fail(`probe did not import every entry point cleanly: ${out}`);
    console.log(`  imports:      5/5 entry points resolved under Node ESM`);
  } catch (err) {
    fail(`Node import probe failed: ${err.message}`);
  }
}

function verifyTypeScriptConsumer(installedPkgDir, consumerDir) {
  step("Compile TypeScript consumer under NodeNext");
  // consumer.ts lives directly in consumer/ so NodeNext walks up to
  // consumer/node_modules/@apo-ai/sdk without crossing into the Apo repo.
  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: false,
          // Scope type acquisition to the consumer dir; do not let tsc walk
          // up into the Apo repo and pull workspace types in. @types/node is
          // installed in the consumer so the SDK's emitted Buffer/global
          // references resolve correctly.
          types: ["node"],
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(consumerDir, "consumer.ts"),
    `
import { configureApoTelemetry, type ApoTelemetryHandle } from "@apo-ai/sdk/otel";
import { task, defineAdapter, runTask, includes, matches } from "@apo-ai/sdk/agent-task";
import { createApoTracer } from "@apo-ai/sdk/agent-task/integrations/ai-sdk";
import { createApoOpenAI } from "@apo-ai/sdk/agent-task/integrations/openai";
import { createApoAnthropic } from "@apo-ai/sdk/agent-task/integrations/anthropic";

void configureApoTelemetry;
void task;
void defineAdapter;
void runTask;
void includes;
void matches;
void createApoTracer;
void createApoOpenAI;
void createApoAnthropic;
type _Handle = ApoTelemetryHandle;
`,
  );
  try {
    run("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: consumerDir });
    console.log("  tsc:          compiled under NodeNext without errors");
  } catch (err) {
    fail(`TypeScript consumer compile failed: ${err.stdout || err.message}`);
  }
}

function verifyPublint(installedPkgDir, consumerDir) {
  step("Run publint against installed package");
  // publint is already installed in the consumer dir alongside the SDK
  // tarball (single npm install). Point it at the installed package path so
  // it cannot accidentally lint the Apo repo manifest.
  try {
    const out = run(
      "npx",
      ["publint", "--strict", installedPkgDir],
      { cwd: consumerDir },
    );
    process.stdout.write(out ? `  ${out}\n` : "  (publint silent)\n");
    console.log("  publint:      zero errors");
  } catch (err) {
    fail(`publint reported issues:\n${err.stdout || err.message}`);
  }
}

// ─── main ────────────────────────────────────────────────────────────────

function main() {
  const sourceManifest = readJson(join(PKG_DIR, "package.json"));
  console.log(`Verifying @apo-ai/sdk@${sourceManifest.version} from ${PKG_DIR}`);

  const tempDir = createTempDir();
  let summary = null;
  try {
    const { tarball, sizeKb } = packSdk(tempDir);
    const { consumerDir, installedPkgDir } = installTarball(tempDir, tarball);
    verifyInstalledManifest(installedPkgDir, sourceManifest);
    verifyTargetsExist(installedPkgDir);
    const { fileCount } = verifyNoSourceShipped(installedPkgDir);
    verifyLicenseAndReadme(installedPkgDir);
    verifyNodeImports(installedPkgDir, consumerDir);
    verifyTypeScriptConsumer(installedPkgDir, consumerDir);
    verifyPublint(installedPkgDir, consumerDir);

    summary = {
      tarball: relative(REPO_ROOT, tarball),
      version: sourceManifest.version,
      compressedKb: sizeKb,
      files: fileCount,
      exports: PUBLIC_EXPORTS,
    };
  } finally {
    // Always clean up, success or failure.
    try {
      rmSync(tempDir, { recursive: true, force: true });
      console.log(`\n ▸ cleaned temp dir`);
    } catch (err) {
      console.error(`  warning: could not remove temp dir ${tempDir}: ${err.message}`);
    }
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error("\n✖ package:check FAILED");
    process.exit(process.exitCode);
  }

  console.log(`\n✓ @apo-ai/sdk@${summary.version} verified`);
  console.log(`  tarball:    ${summary.tarball} (${summary.compressedKb} KB compressed)`);
  console.log(`  files:      ${summary.files} in installed package`);
  console.log(`  exports:    ${summary.exports.length} public entry points`);
  for (const e of summary.exports) console.log(`    • ${e}`);
}

main();
