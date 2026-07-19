import { apiClient } from "./api-client";
import { backendFetch } from "./backend-fetch";
import { getBrowserBackendBaseUrl } from "./config";

// ============================================================================
// Types
// ============================================================================

export interface DatabaseDescriptor {
  engine: "postgres" | "sqlite" | "unknown";
  host: string | null;
  name: string | null;
  credentials_configured: boolean;
  shared_use_recommended: boolean;
}

export type DeploymentProfile = "development" | "local" | "server";

export interface RuntimeConfig {
  backend_url: string;
  frontend_url: string;
  public_url: string;
  database: DatabaseDescriptor;
  task_source_cache_dir: string;
  task_execution_mode: "local_subprocess";
  scheduler_enabled: boolean;
  deployment_profile: DeploymentProfile;
  supported_topology: "single-node";
  max_concurrent_batches: number;
  trusted_task_sources_only: true;
}

export interface AgentTaskRuntimeStatus {
  available: boolean;
  node_version: string | null;
  runner_path: string | null;
  error: string | null;
}

export interface ReadinessCheckResult {
  name: string;
  ok: boolean;
  detail: string | null;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, ReadinessCheckResult>;
}

// ============================================================================
// API helpers
// ============================================================================

export const fetchRuntimeConfig = (): Promise<RuntimeConfig> =>
  apiClient("/v1/system/runtime-config");

export const fetchTaskRuntimeStatus = (): Promise<AgentTaskRuntimeStatus> =>
  apiClient("/v1/system/task-runtime");

// fetchReadinessReport intentionally does NOT throw on a failing check — the
// health endpoint returns a body with per-check detail even when overall ok
// is false, and the panel renders that detail. Stays on the low-level fetch.
export async function fetchReadinessReport(): Promise<ReadinessReport> {
  const res = await backendFetch(`${getBrowserBackendBaseUrl()}/health/ready`);
  return (await res.json()) as ReadinessReport;
}
