import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hostname } from "node:os";
import { isAbsolute, resolve } from "path";
import { parseArgs, getBoolFlag, getFlagValue } from "../lib/args.ts";
import { dim, green, red } from "../lib/format.ts";
import { apiPost, AuthError, isBackendReachable } from "../lib/api.ts";
import { pickOption } from "../lib/picker.ts";
import { resolveProject } from "../lib/projects.ts";
import {
  readCredentials,
  writeCredentials,
} from "../lib/credentials.ts";

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

type VerifyPasswordProject = {
  id: string;
  name: string;
  role: string | null;
};

type VerifyPasswordResponse = {
  id: string;
  email: string;
  name: string;
  is_admin: boolean;
  projects?: VerifyPasswordProject[];
};

async function prompt(rl: any, question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` ${dim(`[${defaultValue}]`)}` : "";
  const answer = (await rl.question(`${question}:${suffix} `)).trim();
  return answer || defaultValue || "";
}

async function checkSavedKey(
  backendUrl: string,
  apiKey: string,
): Promise<"valid" | "invalid" | "unknown"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${backendUrl}/v1/projects`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.ok) return "valid";
    if (res.status === 401) return "invalid";
    return "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

async function promptPassword(rl: any, question: string): Promise<string> {
  // Close the readline interface first — otherwise it keeps echoing each
  // typed character to stdout on top of our own "*" masking (double echo).
  rl.close();
  return new Promise((resolve) => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const chunks: Buffer[] = [];
    stdout.write(`${question}: `);
    const onData = (chunk: Buffer) => {
      const byte = chunk[0];
      if (byte === 0x0d || byte === 0x0a) {
        process.stdin.setRawMode?.(false);
        process.stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(Buffer.concat(chunks).toString("utf8"));
      } else if (byte === 0x03) {
        process.exit(130);
      } else if (byte === 0x7f || byte === 0x08) {
        if (chunks.length > 0) {
          chunks.pop();
          stdout.write("\b \b");
        }
      } else {
        chunks.push(chunk);
        stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const force = getBoolFlag(flags, "force");

  const existing = readCredentials();

  // Verify the saved key actually works against the CURRENT backend before
  // claiming success. The credentials file existing is not enough: switching
  // backends (e.g. `pnpm dev` <-> docker) leaves a key that's valid for one
  // database but rejected (401) by another, which used to deadlock the CLI
  // ("already logged in" yet every command failed).
  if (existing?.email && existing?.api_key && !force) {
    const status = await checkSavedKey(existing.backend_url, existing.api_key);
    if (status === "valid") {
      console.log(green(`\u2713 Already logged in as ${existing.email}.`));
      console.log(dim(`  Backend: ${existing.backend_url}`));
      console.log(dim(`  Use \`apo logout\` to sign out, or \`apo login --force\` to re-authenticate.`));
      return 0;
    }
    if (status === "invalid") {
      console.log(dim(`Saved key for ${existing.email} is not valid for ${existing.backend_url}. Re-authenticating…`));
      // fall through to the normal email + password flow
    } else {
      // Backend unreachable — can't verify, so don't block: claim logged in
      // but note we couldn't confirm.
      console.log(green(`\u2713 Already logged in as ${existing.email}.`));
      console.log(dim(`  Backend: ${existing.backend_url} (couldn't reach it to verify the key)`));
      return 0;
    }
  }

  const defaultBackend = "http://localhost:8000";

  const backendUrlFlag = getFlagValue(flags, "backend");
  const emailFlag = getFlagValue(flags, "email");
  const passwordFlag = getFlagValue(flags, "password");

  let backendUrl = backendUrlFlag ?? existing?.backend_url ?? defaultBackend;

  if (!backendUrlFlag) {
    if (!(await isBackendReachable(backendUrl))) {
      console.error(red(`Cannot reach backend at ${backendUrl}`));
      const rl = createInterface({ input: stdin, output: stdout });
      backendUrl = await prompt(rl, "Backend URL", defaultBackend);
      rl.close();
      if (!(await isBackendReachable(backendUrl))) {
        console.error(red(`Still cannot reach ${backendUrl}. Aborting.`));
        return 2;
      }
    }
  }

  const rl = createInterface({ input: stdin, output: stdout });

  let email = emailFlag;
  if (!email) {
    email = await prompt(rl, "Email", existing?.email);
  }

  if (!email) {
    console.error(red("Email is required."));
    rl.close();
    return 2;
  }

  let password: string;
  if (passwordFlag) {
    password = passwordFlag;
    rl.close();
  } else {
    password = await promptPassword(rl, "Password");
  }
  // Release stdin so the process can exit — readline + raw-mode password
  // input leave it resumed, which keeps the Node event loop alive and makes
  // the CLI hang after a successful login.
  process.stdin.pause();
  process.stdin.setRawMode?.(false);

  if (!password) {
    console.error(red("Password is required."));
    return 2;
  }

  // Verify credentials and discover the projects this account can access.
  let projects: VerifyPasswordProject[];
  try {
    const verify = await apiPost<VerifyPasswordResponse>(
      backendUrl,
      "/auth/verify-password",
      { email, password },
    );
    projects = verify.projects ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthError || message.includes("401")) {
      console.error(red("Invalid email or password."));
    } else if (message.includes("429")) {
      console.error(red("Too many attempts. Try again in a few minutes."));
    } else if (message.startsWith("Backend error")) {
      console.error(red("Login rejected by backend. Check the backend URL and account, then try again."));
    } else {
      console.error(red(`Cannot connect to backend at ${backendUrl}.`));
    }
    return 2;
  }

  // Select a project: `--project <id|name>` for agents/CI; an interactive
  // picker for humans; auto-select when only one is available.
  const projectFlag = getFlagValue(flags, "project");
  let chosenProject: VerifyPasswordProject | undefined;
  if (projectFlag) {
    const result = resolveProject(projects, projectFlag);
    if (result.status === "none") {
      console.error(red(`No project matching "${projectFlag}".`));
      if (projects.length > 0) {
        console.error(dim(`  Your projects: ${projects.map((p) => `${p.name} (${p.id})`).join(", ")}`));
      }
      return 2;
    }
    if (result.status === "ambiguous") {
      console.error(red(`"${projectFlag}" matches multiple projects:`));
      console.error(dim(`  ${result.items.map((p) => `${p.id} (${p.name})`).join(", ")}`));
      console.error(dim("  Use a longer prefix."));
      return 2;
    }
    chosenProject = result.item;
  } else if (projects.length === 0) {
    console.error(red("This account has no projects yet."));
    console.error(dim("  Create one in the dashboard, then run `apo login` again."));
    return 2;
  } else if (projects.length === 1) {
    chosenProject = projects[0];
    console.log(dim(`Project: ${chosenProject.name} (${chosenProject.id})`));
  } else {
    const pickedId = await pickOption(
      "Select a project",
      projects.map((p) => ({ label: p.name, value: p.id, hint: p.id })),
    );
    if (!pickedId) {
      return 2;
    }
    chosenProject = projects.find((p) => p.id === pickedId);
  }

  if (!chosenProject) {
    console.error(red("No project selected."));
    return 2;
  }

  // Mint an API key scoped to the chosen project.
  let result: BootstrapResponse;
  try {
    result = await apiPost<BootstrapResponse>(
      backendUrl,
      "/v1/api-keys/bootstrap",
      {
        email,
        password,
        name: `apo-cli@${hostname()}`,
        project: chosenProject.id,
        scope: "full",
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AuthError || message.includes("401")) {
      console.error(red("Invalid email or password."));
    } else if (message.includes("429")) {
      console.error(red("Too many attempts. Try again in a few minutes."));
    } else if (message.startsWith("Backend error")) {
      console.error(red(`Could not create an API key for project "${chosenProject.name}".`));
    } else {
      console.error(red(`Cannot connect to backend at ${backendUrl}.`));
    }
    return 2;
  }

  const taskRootFlag = getFlagValue(flags, "dir");
  let taskRoot = taskRootFlag ?? existing?.task_root ?? "./e2e";
  if (!isAbsolute(taskRoot)) {
    taskRoot = resolve(taskRoot);
  }

  const path = writeCredentials({
    backend_url: backendUrl,
    api_key: result.key,
    email,
    task_root: taskRoot,
    project: chosenProject.id,
  });

  console.log(green(`\u2713 Logged in as ${email}`));
  console.log(`  Backend:  ${backendUrl}`);
  console.log(`  Project:  ${chosenProject.name} (${chosenProject.id})`);
  console.log(`  Key:      ${result.prefix}${dim("...")} (${result.scope})`);
  console.log(`  Saved to: ${path}`);

  if (existing) {
    console.log(dim("\nPrevious credentials overwritten."));
  }

  return 0;
}
