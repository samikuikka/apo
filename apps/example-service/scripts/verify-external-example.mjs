/**
 * verify-external-example.mjs — prove the canonical example loads through
 * packed SDK + CLI artifacts in a clean temporary consumer.
 *
 * Packs both packages, copies the explicit example dependency closure to a
 * temp dir outside the workspace, installs the tarballs with npm, typechecks
 * the example, loads the Task through the installed SDK, discovers it through
 * the installed CLI, and cleans up.
 *
 * No provider credentials, no backend, no model calls.
 */
import { mkdtempSync, rmSync, cpSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const EXAMPLE_ROOT = join(scriptDir, "..");
const REPO_ROOT = join(scriptDir, "../../..");

// ── Explicit dependency closure ──
// Preserves the original directory structure so relative imports resolve.
const CLOSURE = [
  // The Task definition and inputs
  ["e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/data-extraction.eval.ts",
   "e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/data-extraction.eval.ts"],
  ["e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/files/instructions.md",
   "e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/files/instructions.md"],
  ["e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/files/invoice.txt",
   "e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/files/invoice.txt"],
  // The Adapter + its helpers
  ["e2e/agent-task-demo/ai-sdk-adapter.ts",
   "e2e/agent-task-demo/ai-sdk-adapter.ts"],
  ["e2e/agent-task-demo/lib/files.ts",
   "e2e/agent-task-demo/lib/files.ts"],
  ["e2e/agent-task-demo/lib/deliverables.ts",
   "e2e/agent-task-demo/lib/deliverables.ts"],
  ["e2e/agent-task-demo/lib/mcp.ts",
   "e2e/agent-task-demo/lib/mcp.ts"],
  ["e2e/agent-task-demo/agent/types.ts",
   "e2e/agent-task-demo/agent/types.ts"],
  // The real agent
  ["app/lib/agent/service.ts",
   "app/lib/agent/service.ts"],
];

function step(msg) { console.log(msg); }

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "apo-ext-example-"));
  try {
    // 1. Pack SDK + CLI.
    step("SDK packed and installed");
    execSync("pnpm --filter @apo-ai/sdk pack --pack-destination " + tempDir, { cwd: REPO_ROOT, stdio: "pipe" });
    execSync("pnpm --filter @apo-ai/cli pack --pack-destination " + tempDir, { cwd: REPO_ROOT, stdio: "pipe" });
    const sdkTgz = findTgz(tempDir, "apo-ai-sdk");
    const cliTgz = findTgz(tempDir, "apo-ai-cli");
    if (!sdkTgz || !cliTgz) throw new Error("Failed to find packed tarballs");

    // 2. Copy the explicit dependency closure.
    step("example dependency closure copied outside the workspace");
    const consumerDir = join(tempDir, "consumer");
    for (const [src, dest] of CLOSURE) {
      const srcPath = join(EXAMPLE_ROOT, src);
      const destPath = join(consumerDir, dest);
      cpSync(srcPath, destPath, { recursive: true });
    }

    // 3. Create consumer package.json.
    const pkg = {
      name: "apo-ext-example-consumer",
      private: true,
      type: "module",
      dependencies: {
        "@apo-ai/sdk": `file:${sdkTgz}`,
        "@apo-ai/cli": `file:${cliTgz}`,
        "ai": "^6.0.3",
        "@ai-sdk/openai": "^3.0.1",
        "zod": "^3.22.0",
      },
      devDependencies: {
        "typescript": "^5.9.3",
        "@types/node": "^20",
      },
    };
    writeFileSync(join(consumerDir, "package.json"), JSON.stringify(pkg, null, 2));

    // 4. Install.
    execSync("npm install --ignore-scripts --no-audit --no-fund", { cwd: consumerDir, stdio: "pipe" });

    // 5. TypeScript compilation.
    writeFileSync(join(consumerDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        noUnusedLocals: false,
        types: ["node"],
      },
      include: ["e2e/**/*.ts", "app/**/*.ts", "probe.ts"],
    }));

    writeFileSync(join(consumerDir, "probe.ts"), PROBE_SOURCE);
    execSync("npx tsc --noEmit", { cwd: consumerDir, stdio: "pipe" });
    step("TypeScript compilation passed");

    // 6. Load the Task through the installed SDK.
    execSync("node --experimental-strip-types probe.ts", {
      cwd: consumerDir,
      stdio: "pipe",
      env: { ...process.env, TASK_DIR: "e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction" },
    });
    step("Task data-extraction loaded from the installed SDK");

    // 7. Discover via installed CLI.
    const cliBin = join(consumerDir, "node_modules/@apo-ai/cli/dist/main.js");
    const output = execSync(
      `node ${cliBin} task list --json --dir e2e/agent-task-demo/tasks/ai-sdk-agent --backend http://127.0.0.1:59999`,
      { cwd: consumerDir, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, APO_BACKEND_URL: "http://127.0.0.1:59999" } },
    ).toString();
    const parsed = JSON.parse(output);
    const taskList = Array.isArray(parsed) ? parsed : (parsed.tasks ?? parsed.data ?? []);
    if (!taskList.some((t) => t.id === "data-extraction")) {
      throw new Error("CLI did not discover data-extraction");
    }
    step("CLI discovered data-extraction locally");

    console.log("\nAll boundaries proven.");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function findTgz(dir, name) {
  for (const f of readdirSync(dir)) {
    if (f.startsWith(name) && f.endsWith(".tgz")) return join(dir, f);
  }
  return null;
}

const PROBE_SOURCE = `
import { loadTask } from "@apo-ai/sdk/agent-task";

const taskDir = process.env.TASK_DIR!;
const loaded = await loadTask(taskDir);

const assert = (cond: boolean, msg: string) => { if (!cond) { console.error("FAIL: " + msg); process.exit(1); } };

assert(loaded.task.id === "data-extraction", "task id is data-extraction");
assert(loaded.adapter.name === "ai-sdk-agent", "adapter name is ai-sdk-agent");
assert(loaded.task.deliverables.includes("result"), "has result deliverable");
assert(loaded.task.deliverables.includes("tool_log"), "has tool_log deliverable");
assert(loaded.task.deliverables.includes("stats"), "has stats deliverable");
assert(loaded.files.some((f) => f.relativePath.endsWith("invoice.txt")), "has invoice.txt");
assert(loaded.files.some((f) => f.relativePath.endsWith("instructions.md")), "has instructions.md");

console.log("probe: ok — task loaded, assertions passed");
`;

main().catch((err) => {
  console.error("verify-external-example: FAIL");
  console.error("  " + (err.message || err));
  process.exit(1);
});
