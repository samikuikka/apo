import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAgentTaskCli } from "@apo/sdk/agent-task";

// Load env vars from the example-service .env so OPENROUTER_MODEL / API_KEY
// are available to the SDK runner + the agent-under-test. Mirrors the load
// order in packages/cli/src/commands/task-run.ts:loadEnvFiles.
for (const file of [
  "apps/example-service/.env",
  ".env",
  "backend/.env",
]) {
  try {
    for (const line of readFileSync(resolve(file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // skip missing/unreadable env file
  }
}

runAgentTaskCli(process.argv.slice(2), process.cwd())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 2;
  });