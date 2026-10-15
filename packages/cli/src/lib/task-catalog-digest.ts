/**
 * Canonical catalog digest for TypeScript.
 *
 * Must produce the exact same digest as the Python compute_catalog_digest,
 * which uses ``json.dumps(doc, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)``: tasks ordered by task_id in Unicode code-point
 * order, keys sorted recursively, compact separators, characters raw.
 * Python sorts strings by code point, so the comparators here compare UTF-8
 * bytes (byte order equals code-point order); localeCompare would order
 * mixed-case ids differently and break the digest for both languages.
 */

import { createHash } from "node:crypto";
import type { PublishedTask } from "./task-catalog.ts";

function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function stableCanonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort(compareUtf8Bytes)) {
    sorted[key] = stableCanonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function computeCatalogDigest(tasks: PublishedTask[]): string {
  const normalized = tasks
    .map((t) => ({
      task_id: t.task_id,
      display_name: t.display_name,
      task_path: t.task_path,
      folder_path: t.folder_path,
      adapter_name: t.adapter_name,
      has_checks: t.has_checks,
      tags: [...t.tags].sort(compareUtf8Bytes),
    }))
    .sort((a, b) => compareUtf8Bytes(a.task_id, b.task_id));

  // Compact JSON with recursively sorted keys and raw characters; hashing a
  // string hashes its UTF-8 bytes, matching Python's encode("utf-8").
  const payload = JSON.stringify(stableCanonicalize({ schema_version: 1, tasks: normalized }));
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}
