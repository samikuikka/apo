/**
 * Retrieval evidence — the boundary between whatever a retriever returns and
 * the typed documents assertions match on.
 *
 * A retrieval is an action with content: a query in, ranked documents out.
 * Retrievers return wildly different shapes, so the projection tee parses the
 * return value once at capture into the OpenInference document names (id,
 * score, content) and readers only ever see the typed result. Snapshots that
 * did not pass through the tee (canonical backend projections, injected
 * replay observations) go through the same parser at read time, so both
 * paths agree on what counts as recognized.
 */

import type { TraceProjectionObservation } from "./types.ts";

/** One retrieved document. Attribute names follow the OpenInference spec. */
export interface TraceProjectionDocument {
  /** Stable corpus id when the retriever reports one. Absent for content-only retrievers. */
  id?: string;
  /** Similarity score when reported. Finite only. */
  score?: number;
  /** The retrieved text. */
  content: string;
}

/**
 * Parse a retriever result into documents. Recognized shapes: a
 * `{ documents: [...] }` wrapper, or a bare array; items are objects with
 * `content`/`text` and optional `id`/`score`, or plain strings. Returns
 * `undefined` for unrecognized shapes — unknown stays unknown, never "no
 * documents".
 */
export function parseRetrievedDocuments(
  output: unknown,
): TraceProjectionDocument[] | undefined {
  const array = documentsArray(output);
  if (array === undefined) return undefined;
  const documents: TraceProjectionDocument[] = [];
  for (const item of array) {
    const document = parseDocument(item);
    if (document !== undefined) documents.push(document);
  }
  return documents;
}

/** Documents for one retrieval observation; `undefined` = shape not recognized. */
export function documentsFromObservation(
  obs: Pick<TraceProjectionObservation, "output">,
): TraceProjectionDocument[] | undefined {
  const output = obs.output;
  if (output != null && typeof output === "object" && !Array.isArray(output)) {
    const documents = (output as { documents?: unknown }).documents;
    if (Array.isArray(documents)) return parseRetrievedDocuments(documents);
  }
  return parseRetrievedDocuments(output);
}

/** The query a retrieval observation was invoked with, when recorded. */
export function retrievalQueryFrom(input: unknown): string | undefined {
  if (input != null && typeof input === "object") {
    const query = (input as { query?: unknown }).query;
    if (typeof query === "string") return query;
  }
  return undefined;
}

function documentsArray(output: unknown): readonly unknown[] | undefined {
  if (Array.isArray(output)) return output;
  if (output != null && typeof output === "object") {
    const wrapped = (output as { documents?: unknown }).documents;
    if (Array.isArray(wrapped)) return wrapped;
  }
  return undefined;
}

function parseDocument(item: unknown): TraceProjectionDocument | undefined {
  if (typeof item === "string") {
    return item.length > 0 ? { content: item } : undefined;
  }
  if (item == null || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const rawContent = record.content ?? record.text;
  const content = typeof rawContent === "string" ? rawContent : "";
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
  // A document needs something to match on: its text or its id.
  if (content.length === 0 && id === undefined) return undefined;
  const document: TraceProjectionDocument = { content };
  if (id !== undefined) document.id = id;
  if (typeof record.score === "number" && Number.isFinite(record.score)) {
    document.score = record.score;
  }
  return document;
}
