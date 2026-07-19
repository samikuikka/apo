import { getBrowserBackendBaseUrl } from "./config";
import { backendFetch } from "./backend-fetch";

const API_BASE = getBrowserBackendBaseUrl();

export interface ScoreConfig {
  id: number;
  name: string;
  data_type: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  min_value: number | null;
  max_value: number | null;
  categories: Record<string, unknown> | null;
  description: string | null;
}

export interface ScoreResponse {
  id: number;
  trace_id: string | null;
  observation_id: string | null;
  name: string;
  value: number | string | boolean | null;
  string_value: string | null;
  data_type: string;
  source: string;
  config_id: number | null;
  comment: string | null;
  created_at: string;
}

export interface CreateScoreRequest {
  name: string;
  value: number | string | boolean;
  data_type: string;
  source?: string;
  config_id?: number | null;
  comment?: string | null;
}

export async function getScoreConfigs(
  project?: string,
): Promise<ScoreConfig[]> {
  const params = new URLSearchParams();
  if (project) params.set("project", project);

  try {
    const res = await backendFetch(`${API_BASE}/api/v1/score-configs?${params}`, {
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as ScoreConfig[];
  } catch {
    return [];
  }
}

export async function createTraceScore(
  traceId: string,
  request: CreateScoreRequest,
): Promise<ScoreResponse> {
  const res = await backendFetch(`${API_BASE}/api/v1/traces/${traceId}/scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(
      error?.detail || `Failed to create score: ${res.status}`,
    );
  }
  return (await res.json()) as ScoreResponse;
}

export async function createObservationScore(
  observationId: string,
  request: CreateScoreRequest,
): Promise<ScoreResponse> {
  const res = await backendFetch(
    `${API_BASE}/api/v1/observations/${observationId}/scores`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(
      error?.detail || `Failed to create score: ${res.status}`,
    );
  }
  return (await res.json()) as ScoreResponse;
}

export async function getTraceScores(
  traceId: string,
): Promise<ScoreResponse[]> {
  try {
    const res = await backendFetch(
      `${API_BASE}/api/v1/traces/${traceId}/scores`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    return (await res.json()) as ScoreResponse[];
  } catch {
    return [];
  }
}
