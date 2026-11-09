/**
 * The handbook chatbot's retriever: a small lexical index over a multi-tenant
 * document store. Deliberately plain (term overlap, no embeddings) so the
 * demo runs without an embedding API, while still behaving like a real
 * retriever: ranked results, scores, and a tenant filter that keeps one
 * customer's documents out of another customer's answers.
 */
import { readFileSync } from "fs";
import type { FileEntry } from "@apo-ai/sdk/agent-task";

export interface HandbookDocument {
  id: string;
  tenant: string;
  content: string;
}

export interface RetrievedPassage {
  id: string;
  score: number;
  content: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "can", "how", "many", "get", "does", "what", "when", "with",
  "from", "into", "per", "you", "your", "our", "their", "any", "has", "have", "will", "this",
]);

/** Load the document store from the task's `handbook.json`. */
export function loadHandbook(files: FileEntry[]): HandbookDocument[] {
  const entry = files.find((f) => f.relativePath === "handbook.json");
  if (!entry) throw new Error("rag-handbook tasks need a files/handbook.json document store");
  return JSON.parse(readFileSync(entry.absolutePath, "utf-8")) as HandbookDocument[];
}

/**
 * Top passages for `query`, best first. `tenant` scopes the search to one
 * customer's documents; leaving it out searches every tenant, which is the
 * cross-tenant leak the demo task guards against.
 */
export function searchHandbook(
  corpus: readonly HandbookDocument[],
  query: string,
  opts: { tenant?: string; limit?: number } = {},
): RetrievedPassage[] {
  const queryTerms = new Set(terms(query));
  return corpus
    .filter((doc) => opts.tenant === undefined || doc.tenant === opts.tenant)
    .map((doc) => {
      const words = terms(doc.content);
      const hits = words.filter((word) => queryTerms.has(word)).length;
      return { doc, score: hits / Math.sqrt(Math.max(words.length, 1)) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, opts.limit ?? 3)
    .map(({ doc, score }) => ({ id: doc.id, score: Math.round(score * 1000) / 1000, content: doc.content }));
}

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (word) => word.length > 2 && !STOPWORDS.has(word),
  );
}
