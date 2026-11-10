/**
 * Groundedness, the hallucination check for retrieval-augmented answers:
 * every factual claim in an answer must be supported by the sources it was
 * given. A fixed rubric over the regular judge pipeline, so the second judge,
 * cascade mode and `expect` work exactly as they do for `t.judge`.
 */

import type { TraceProjectionDocument } from "../trace-projection/retrieval.ts";
import type { TraceRetrieval } from "../trace-projection/view.ts";

export const GROUNDEDNESS_RUBRIC = [
  "Value 1 is an answer. Value 2 is the set of source documents the answer was supposed to rely on.",
  "Decide whether the answer is grounded in the sources. Check every factual claim in the answer. " +
    "A claim is supported only when a source states it, or it follows directly from what a source states. " +
    "Greetings, hedges, and statements that the answer cannot help are not factual claims.",
  "PASS when every factual claim is supported. FAIL when any factual claim is unsupported or " +
    "contradicted by the sources, even if it is true in the real world. Groundedness measures the " +
    "answer against these sources, not against your own knowledge. In your reasoning, name each " +
    "unsupported claim.",
].join("\n\n");

/** The run's retrieved documents as the judge's source list. A document retrieved twice appears once. */
export function formatTraceSources(retrievals: readonly TraceRetrieval[]): string {
  const seen = new Set<string>();
  const documents: TraceProjectionDocument[] = [];
  for (const retrieval of retrievals) {
    for (const document of retrieval.documents ?? []) {
      const key = document.id ?? document.content;
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push(document);
    }
  }
  return formatSources(documents);
}

export function formatAuthorSources(sources: readonly string[]): string {
  return formatSources(sources.map((content) => ({ content })));
}

function formatSources(documents: readonly TraceProjectionDocument[]): string {
  if (documents.length === 0) return "(no documents were retrieved)";
  return documents
    .map((document, i) => {
      const heading = document.id === undefined ? `[${i + 1}]` : `[${i + 1}] ${document.id}`;
      return `${heading}\n${document.content}`;
    })
    .join("\n\n");
}
