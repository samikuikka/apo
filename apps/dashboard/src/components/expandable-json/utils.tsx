import type { ReactNode } from "react";

export type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";

export type JsonNode = {
  id: string;
  key: string | number | null;
  type: JsonType;
  value?: unknown;
  children: JsonNode[];
  depth: number;
  childCount: number;
};

export type StringMode = "truncate" | "wrap" | "nowrap";

export const TYPE_COLORS: Record<JsonType, string> = {
  string: "text-emerald-600 dark:text-emerald-400",
  number: "text-amber-600 dark:text-amber-400",
  boolean: "text-indigo-600 dark:text-indigo-400",
  null: "text-muted-foreground/60",
  object: "",
  array: "",
};

export const TRUNCATE_AT = 120;
export const ROW_HEIGHT = 22;
export const VIRTUALIZE_THRESHOLD = 1000;
export const OVERSCAN = 50;

export function getType(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : (typeof v as JsonType);
}

export function buildTree(
  value: unknown,
  key: string | number | null,
  id: string,
  depth: number,
): JsonNode {
  const type = getType(value);

  if (type === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      id,
      key,
      type,
      children: entries.map(([k, v]) => buildTree(v, k, `${id}.${k}`, depth + 1)),
      depth,
      childCount: entries.length,
    };
  }

  if (type === "array") {
    const arr = value as unknown[];
    return {
      id,
      key,
      type,
      children: arr.map((v, i) => buildTree(v, i, `${id}[${i}]`, depth + 1)),
      depth,
      childCount: arr.length,
    };
  }

  return { id, key, type, value, children: [], depth, childCount: 0 };
}

export function flattenVisible(
  nodes: JsonNode[],
  collapsed: Set<string>,
  matches: { all: Set<string> } | null,
): Array<{ node: JsonNode; isLast: boolean }> {
  const result: Array<{ node: JsonNode; isLast: boolean }> = [];

  function visit(n: JsonNode, isLast: boolean) {
    if (matches && !matches.all.has(n.id)) return;
    result.push({ node: n, isLast });
    if ((n.type === "object" || n.type === "array") && !collapsed.has(n.id)) {
      n.children.forEach((child, i) => visit(child, i === n.children.length - 1));
    }
  }

  nodes.forEach((n, i) => visit(n, i === nodes.length - 1));
  return result;
}

export function collectMatches(
  node: JsonNode,
  query: string,
): { all: Set<string>; direct: Set<string> } | null {
  if (!query) return null;
  const lq = query.toLowerCase();
  const all = new Set<string>();
  const direct = new Set<string>();

  function walk(n: JsonNode): boolean {
    const keyStr = String(n.key ?? "").toLowerCase();
    const valStr =
      n.type !== "object" && n.type !== "array"
        ? String(n.value ?? "").toLowerCase()
        : "";

    const selfMatch = keyStr.includes(lq) || valStr.includes(lq);
    let childMatch = false;

    for (const child of n.children) {
      if (walk(child)) {
        childMatch = true;
        all.add(n.id);
      }
    }

    if (selfMatch) {
      all.add(n.id);
      direct.add(n.id);
    }

    return selfMatch || childMatch;
  }

  walk(node);
  return direct.size > 0 ? { all, direct } : null;
}

export function formatPreview(node: JsonNode): string {
  if (node.type === "object") return `{${node.childCount} key${node.childCount === 1 ? "" : "s"}}`;
  if (node.type === "array") return `Array(${node.childCount})`;
  return "";
}

export function highlightText(
  text: string,
  query: string,
  isCurrentMatch: boolean,
): ReactNode {
  if (!query) return <>{text}</>;
  const lq = query.toLowerCase();
  const segments: Array<{ text: string; match: boolean }> = [];
  let remaining = text;
  const cls = isCurrentMatch
    ? "rounded bg-amber-400/40 text-foreground ring-1 ring-amber-400/60"
    : "rounded bg-amber-400/20 text-foreground";

  while (remaining.length > 0) {
    const idx = remaining.toLowerCase().indexOf(lq);
    if (idx === -1) {
      segments.push({ text: remaining, match: false });
      break;
    }
    if (idx > 0) segments.push({ text: remaining.slice(0, idx), match: false });
    segments.push({ text: remaining.slice(idx, idx + query.length), match: true });
    remaining = remaining.slice(idx + query.length);
  }

  return (
    <>
      {segments.map((seg, i) =>
        seg.match ? (
          <span key={`hl-${i}`} className={cls}>
            {seg.text}
          </span>
        ) : (
          <span key={`txt-${i}`}>{seg.text}</span>
        ),
      )}
    </>
  );
}
