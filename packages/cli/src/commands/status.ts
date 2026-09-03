import { existsSync } from "fs";
import { parseArgs } from "../lib/args.ts";
import { isBackendReachable } from "../lib/api.ts";
import {
  credentialsPath,
  listRememberedLogins,
  readCredentials,
} from "../lib/credentials.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, green, red, yellow } from "../lib/format.ts";

/**
 * Print the configuration every command will actually use. `apo login` sets
 * the whole context (backend, project, task root) and remembers one login
 * per backend — this surfaces the active one, the saved ones, and whether
 * they point at things that exist.
 */
export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const stored = readCredentials();

  const reachable = await isBackendReachable(config.backendUrl);
  const rootExists = existsSync(config.taskRoot);
  const saved = listRememberedLogins();

  console.log(bold("apo status"));
  console.log(`  Login:      ${stored?.email ?? dim("not logged in (run: apo login)")}`);
  if (stored?.profile_name) {
    console.log(`  Profile:    ${stored.profile_name} ${dim("(switch: apo profile use <name>)")}`);
  }
  console.log(`  Backend:    ${config.backendUrl} ${reachable ? green("✓ reachable") : red("✗ unreachable")}`);
  console.log(`  Project:    ${config.projectId ?? dim("(none — run: apo project use)")}`);
  console.log(`  Task root:  ${config.taskRoot} ${rootExists ? "" : yellow("(directory does not exist)")}`);
  if (saved.length > 0) {
    const entries = saved
      .map((s) => `${s.backend_url}${s.email ? dim(` (${s.email})`) : ""}`)
      .join(", ");
    console.log(`  Saved:      ${entries}`);
    console.log(dim("  Switch:     apo login --backend <url>"));
  }
  console.log("");
  console.log(dim(`Credentials: ${credentialsPath()}${stored ? "" : " (absent)"}`));
  console.log(dim("Universe: task list / task show / task run resolve from the task root; --catalog lists the published inventory."));

  return 0;
}
