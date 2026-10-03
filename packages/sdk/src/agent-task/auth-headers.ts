/**
 * Env-only auth headers for apo backends: the runner's credential contract
 * (`APO_PUBLIC_KEY`+`APO_SECRET_KEY` → Basic, `APO_AUTH_TOKEN` → Bearer)
 * resolved with no arguments. Same name as the otel entry's builder, but
 * that one accepts explicit keys and returns `{}` when unauthenticated —
 * this variant reports "no headers" as `undefined` instead. Both share one
 * implementation in `apo-auth.ts`.
 */

import { resolveApoAuthHeaders } from "../apo-auth.ts";

export function buildApoAuthHeaders(): Record<string, string> | undefined {
  const headers = resolveApoAuthHeaders();
  return Object.keys(headers).length > 0 ? headers : undefined;
}

