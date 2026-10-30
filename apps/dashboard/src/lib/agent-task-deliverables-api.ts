/**
 * dashboard Deliverable API helpers.
 *
 * The Task Run page fetches only the manifest (metadata). JSON bodies load one
 * at a time on row expansion with an AbortController; artifact downloads use
 * the authenticated same-origin proxy.
 */

import { backendFetch } from "./backend-fetch";

export interface DeliverableSummary {
  id: string;
  name: string;
  kind: "json" | "artifact";
  status: "pending" | "ready" | "failed";
  media_type: string;
  display_filename: string | null;
  size_bytes: number;
  sha256: string;
  download_url: string | null;
}

/**
 * Fetch one JSON Deliverable body. The caller owns the AbortController so a
 * collapse/navigation cancels the in-flight request and no stale state update
 * occurs.
 */
export async function fetchDeliverableBody(
  downloadUrl: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await backendFetch(downloadUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load deliverable (${response.status})`);
  }
  return response.json();
}
