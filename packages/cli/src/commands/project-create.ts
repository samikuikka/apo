import { hostname } from "node:os";
import { resolve } from "node:path";

import { getFlagValue, parseArgs } from "../lib/args.ts";
import { apiPost, AuthError } from "../lib/api.ts";
import { resolveConfig } from "../lib/config.ts";
import { writeCredentials } from "../lib/credentials.ts";
import { bold, dim, formatJson, green, red } from "../lib/format.ts";

type BootstrapResponse = {
  id: string;
  name: string;
  prefix: string;
  project: string;
  created_by: string;
  scope: string;
  created_at: string;
  key: string;
};

const VALID_POLICIES = ["off", "redacted", "full"] as const;
type TraceContentPolicy = (typeof VALID_POLICIES)[number];

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

  const policyFlag = getFlagValue(flags, "trace-content-policy") ?? "redacted";
  if (!VALID_POLICIES.includes(policyFlag as TraceContentPolicy)) {
    console.error(
      red(
        `Invalid --trace-content-policy: ${policyFlag}. Use one of: ${VALID_POLICIES.join(", ")}`,
      ),
    );
    return 2;
  }
  const traceContentPolicy = policyFlag as TraceContentPolicy;

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
        trace_content_policy: traceContentPolicy,
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

  // Persist credentials so the new project becomes the active one — mirrors
  // `apo login`'s post-bootstrap write.
  const taskRootFlag = getFlagValue(flags, "dir");
  const taskRoot = taskRootFlag ? resolve(taskRootFlag) : "./e2e";
  writeCredentials({
    backend_url: config.backendUrl,
    api_key: result.key,
    email,
    task_root: taskRoot,
    project: result.project,
  });

  if (config.json) {
    console.log(formatJson(result));
    return 0;
  }

  console.log(green(`\u2713 Created project ${bold(name)} (${result.project}).`));
  console.log(dim(`  API key: ${result.prefix}\u2026 (saved to ~/.apo/credentials)`));
  console.log(dim(`  Trace content policy: ${traceContentPolicy}`));
  console.log(dim(`  Run \`apo task list\` to verify task discovery.`));
  return 0;
}

function extractDetail(message: string): string {
  // apiPost raises with "Backend error (status NNN): <body>" — pull the body.
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
