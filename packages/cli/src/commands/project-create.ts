import { hostname } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { getFlagValue, parseArgs } from "../lib/args.ts";
import { apiPost, AuthError } from "../lib/api.ts";
import { resolveConfig } from "../lib/config.ts";
import { writeCredentials, writeRememberedLogin } from "../lib/credentials.ts";
import { type BootstrapResponse } from "../lib/api-types.ts";
import { bold, dim, formatJson, green, red } from "../lib/format.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const config = resolveConfig(flags);

  const name = positional[0];
  if (!name) {
    console.error(red("Missing required argument: <name>"));
    console.error(dim("  Usage: apo project create <name> --email ... --password ..."));
    return 2;
  }

  const email = getFlagValue(flags, "email");
  if (!email) {
    console.error(red("Missing required flag: --email <email>"));
    return 2;
  }

  const password = getFlagValue(flags, "password");
  if (!password) {
    console.error(red("Missing required flag: --password <password>"));
    return 2;
  }

  const scope = (getFlagValue(flags, "scope") ?? "full") as "full" | "ingest";

  let result: BootstrapResponse;
  try {
    result = await apiPost<BootstrapResponse>(
      config.backendUrl,
      "/v1/projects/bootstrap",
      {
        email,
        password,
        name,
        key_name: `apo-cli@${hostname()}`,
        scope,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthError) {
      // apiPost raises AuthError on 401 with a generic "Authentication
      // required" message; for the bootstrap flow the credentials were just
      // supplied, so the real cause is a wrong email/password.
      console.error(red("Invalid email or password."));
    } else if (message.includes("Backend error 429")) {
      console.error(red("Too many attempts. Try again in a few minutes."));
    } else if (message.includes("Backend error 400")) {
      console.error(red(`Backend rejected the request: ${extractDetail(message)}`));
    } else if (message.includes("Backend error")) {
      console.error(red(`Could not create project: ${extractDetail(message)}`));
    } else {
      console.error(red(`Cannot connect to backend at ${config.backendUrl}.`));
    }
    return 2;
  }

  // Persist the whole context like `apo login` does, so this bootstrap is a
  // real login: active credentials plus a remembered one for switching back.
  // The task root must be absolute at write time: a relative value stored in
  // ~/.apo/credentials later resolves against ~/.apo, never the directory
  // the command ran from.
  const taskRootFlag = getFlagValue(flags, "dir");
  let taskRoot = taskRootFlag ?? "./e2e";
  if (!isAbsolute(taskRoot)) {
    taskRoot = resolve(taskRoot);
  }
  const creds = {
    backend_url: config.backendUrl,
    api_key: result.key,
    email,
    task_root: taskRoot,
    project: result.project,
  };
  const credentialsPath = writeCredentials(creds);
  writeRememberedLogin(creds);

  if (config.json) {
    console.log(formatJson(result));
    return 0;
  }

  console.log(green(`\u2713 Created project ${bold(name)} (${result.project}).`));
  console.log(dim(`  API key: ${result.prefix}\u2026 (saved to ${credentialsPath})`));
  console.log(dim(`  Run \`apo task list\` to verify task discovery.`));
  return 0;
}

function extractDetail(message: string): string {
  // apiPost raises with "Backend error (status NNN): <body>"; pull the body out.
  const match = message.match(/Backend error \(status \d+\):\s*(.+)$/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.detail) return String(parsed.detail);
    } catch {
      return match[1];
    }
  }
  return message;
}
