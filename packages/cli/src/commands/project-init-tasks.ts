import { getFlagValue, parseArgs } from "../lib/args.ts";
import { apiGet, apiPatch, apiPost } from "../lib/api.ts";
import {
  type AgentTaskSummary,
  type GithubAvailability,
  type GithubConnection,
  type ProjectTaskSource,
} from "../lib/agent-task-types.ts";
import { tryOpenBrowser } from "../lib/browser.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson, yellow } from "../lib/format.ts";

const GITHUB_CONNECTION_POLL_MS = 1_500;
const GITHUB_CONNECTION_TIMEOUT_MS = 180_000;

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  if (!config.projectId) {
    console.error("Missing project. Pass --project <id> or set APO_PROJECT_ID / use apo login.");
    return 2;
  }

  const repoInput = getFlagValue(flags, "repo");
  if (!repoInput) {
    console.error("Missing required flag: --repo <owner/repo | https://github.com/owner/repo(.git)>");
    return 2;
  }

  const branch = getFlagValue(flags, "branch") ?? "main";
  const subpath = getFlagValue(flags, "subpath") ?? null;
  const displayName = getFlagValue(flags, "name") ?? deriveDisplayName(repoInput);
  const normalizedRepo = normalizeGithubRepo(repoInput);

  if (!normalizedRepo) {
    console.error("Invalid --repo value. Use owner/repo or a github.com repository URL.");
    return 2;
  }

  const availability = await loadGithubAvailability(config);
  const connection = await loadGithubConnection(config, availability);

  const source = await apiPatch<ProjectTaskSource>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/task-source`,
    {
      source_type: "git",
      display_name: displayName,
      repository_url: normalizedRepo.repositoryUrl,
      git_ref: branch,
      subpath,
    },
    config,
  );

  let synced = await trySyncTasks(config);
  if (!synced.ok && shouldTryGithubConnect(availability, connection, normalizedRepo.host)) {
    console.log(yellow("Initial sync failed. Attempting GitHub connect before retrying..."));
    const connected = await ensureGithubConnected(config);
    if (!connected) {
      return 2;
    }
    synced = await trySyncTasks(config);
  }

  if (!synced.ok) {
    console.error(synced.message);
    return 2;
  }

  const tasks = await apiGet<AgentTaskSummary[]>(
    config.backendUrl,
    `/v1/projects/${encodeURIComponent(config.projectId)}/agent-tasks`,
    undefined,
    config,
  );

  if (config.json) {
    console.log(formatJson({
      project: config.projectId,
      source,
      synced: synced.source,
      task_count: tasks.length,
      tasks,
    }));
    return 0;
  }

  console.log(bold(`Initialized project tasks: ${config.projectId}`));
  console.log(`  Repository:  ${normalizedRepo.repositorySlug}`);
  console.log(`  Branch:      ${branch}`);
  console.log(`  Subpath:     ${subpath ?? "-"}`);
  console.log(`  Status:      ${synced.source.status}`);
  console.log(`  Commit:      ${synced.source.last_resolved_commit_sha ?? "-"}`);
  console.log(`  Tasks:       ${tasks.length}`);
  return 0;
}

async function loadGithubAvailability(
  config: ReturnType<typeof resolveConfig>,
): Promise<GithubAvailability | null> {
  try {
    return await apiGet<GithubAvailability>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId ?? "")}/github/availability`,
      undefined,
      config,
    );
  } catch {
    return null;
  }
}

async function loadGithubConnection(
  config: ReturnType<typeof resolveConfig>,
  availability: GithubAvailability | null,
): Promise<GithubConnection | null> {
  if (!availability?.enabled) {
    return null;
  }
  try {
    return await apiGet<GithubConnection | null>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId ?? "")}/github/connection`,
      undefined,
      config,
    );
  } catch {
    return null;
  }
}

function shouldTryGithubConnect(
  availability: GithubAvailability | null,
  connection: GithubConnection | null,
  host: string,
): boolean {
  return Boolean(availability?.enabled && !connection && host === "github.com");
}

async function ensureGithubConnected(
  config: ReturnType<typeof resolveConfig>,
): Promise<boolean> {
  let authUrl: string;
  try {
    const next = `/project/${config.projectId}/agent-tasks`;
    const response = await apiGet<{ url: string }>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId ?? "")}/github/auth-url`,
      { next },
      config,
    );
    authUrl = response.url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to start GitHub connect: ${message}`);
    return false;
  }

  const opened = tryOpenBrowser(authUrl);
  console.log(dim(opened ? "Opened browser for GitHub authorization." : "Open this URL to authorize GitHub:"));
  console.log(authUrl);

  const deadline = Date.now() + GITHUB_CONNECTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(GITHUB_CONNECTION_POLL_MS);
    try {
      const connection = await apiGet<GithubConnection | null>(
        config.backendUrl,
        `/v1/projects/${encodeURIComponent(config.projectId ?? "")}/github/connection`,
        undefined,
        config,
      );
      if (connection) {
        console.log(dim(`GitHub connected as @${connection.github_username ?? "user"}`));
        return true;
      }
    } catch {
      // Keep polling through transient callback / session lag.
    }
  }

  console.error("Timed out waiting for GitHub connection.");
  return false;
}

async function trySyncTasks(
  config: ReturnType<typeof resolveConfig>,
): Promise<
  | { ok: true; source: ProjectTaskSource }
  | { ok: false; message: string }
> {
  try {
    const source = await apiPost<ProjectTaskSource>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId ?? "")}/task-source/sync`,
      {},
      config,
    );
    return { ok: true, source };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

function normalizeGithubRepo(input: string): {
  repositoryUrl: string;
  repositorySlug: string;
  host: string;
} | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
      const parts = path.split("/").filter(Boolean);
      if (url.hostname !== "github.com" || parts.length < 2) {
        return null;
      }
      const slug = `${parts[0]}/${parts[1]}`;
      return {
        repositoryUrl: `https://github.com/${slug}.git`,
        repositorySlug: slug,
        host: url.hostname,
      };
    } catch {
      return null;
    }
  }

  const parts = trimmed.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const slug = `${parts[0]}/${parts[1]}`;
  return {
    repositoryUrl: `https://github.com/${slug}.git`,
    repositorySlug: slug,
    host: "github.com",
  };
}

function deriveDisplayName(repoInput: string): string {
  const normalized = normalizeGithubRepo(repoInput);
  return normalized?.repositorySlug ?? "GitHub task source";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
