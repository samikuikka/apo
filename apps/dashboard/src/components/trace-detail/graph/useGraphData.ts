"use client";

import { useMemo } from "react";
import { DataSet } from "vis-data/peer";
import type { LoggedCall } from "../contexts";
import { getSemanticType, getSemanticTypeGraphColors } from "../trace-utils";
import { getDisplayName } from "../trace-display";

export interface GraphNode {
  id: string;
  label: string;
  title: string;
  color: {
    background: string;
    border: string;
  };
  font: {
    color: string;
    size: number;
    face: string;
  };
  level: number;
  call: LoggedCall | null;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  arrows: string;
  color: string;
}

function calculateDepth(
  call: LoggedCall,
  byId: Map<string, LoggedCall>,
  memo: Map<string, number>,
): number {
  if (!call.parent_call_id) return 1;
  if (memo.has(call.id)) return memo.get(call.id)!;

  const parent = byId.get(call.parent_call_id);
  if (!parent) return 1;

  const depth = calculateDepth(parent, byId, memo) + 1;
  memo.set(call.id, depth);
  return depth;
}

function getFgColor() {
  if (typeof document === "undefined") return "#0a0a0a";
  const fg = getComputedStyle(document.documentElement)
    .getPropertyValue("--foreground")
    .trim();
  return fg || "#0a0a0a";
}

export function useGraphData(calls: LoggedCall[], isDark: boolean) {
  // Read the theme variable once per render so the memo can track it via the
  // dependency array. Reading it inside the memo body left the cached node font
  // colors stale when --foreground changed without isDark flipping.
  const fgColor = getFgColor();
  return useMemo(() => {
    const nodes = new DataSet<GraphNode>();
    const edges = new DataSet<GraphEdge>();

    if (calls.length === 0) {
      return { nodes, edges };
    }

    // Index calls by id once (O(n)) so calculateDepth's parent lookup is O(1)
    // instead of the previous O(n) calls.find per call.
    const byId = new Map<string, LoggedCall>();
    for (const call of calls) byId.set(call.id, call);

    const depthMap = new Map<string, number>();
    for (const call of calls) {
      const depth = calculateDepth(call, byId, depthMap);
      depthMap.set(call.id, depth);
    }

    const traceColors = getSemanticTypeGraphColors("TRACE", isDark);

    nodes.add({
      id: "root",
      label: `Run (${calls.length} calls)`,
      title: "Run root",
      color: {
        background: traceColors.background,
        border: traceColors.border,
      },
      font: {
        color: fgColor,
        size: 20,
        face: "Inter, system-ui, sans-serif",
      },
      level: 0,
      call: null,
    });

    // `nodes`/`edges` are local vis-data DataSets, not React props; scanner mis-flags .add().
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    calls.forEach((call) => {
      const semanticType = getSemanticType(call);
      const colors = getSemanticTypeGraphColors(semanticType, isDark);
      const stepName = getDisplayName(call);
      const latency = call.latency_ms ? `${call.latency_ms.toFixed(0)}ms` : "";
      const model = call.model || "";

      nodes.add({
        id: call.id,
        label: stepName,
        title: `${stepName}${model ? `\nModel: ${model}` : ""}${
          latency ? `\nLatency: ${latency}` : ""
        }`,
        color: {
          background: colors.background,
          border: colors.border,
        },
        font: {
          color: fgColor,
          size: 20,
          face: "Inter, system-ui, sans-serif",
        },
        level: depthMap.get(call.id) || 1,
        call,
      });
    });

    calls.forEach((call) => {
      const parentId = call.parent_call_id || "root";
      edges.add({
        id: `${parentId}-${call.id}`,
        from: parentId,
        to: call.id,
        arrows: "to",
        color: "#94a3b8",
      });
    });

    return { nodes, edges };
  }, [calls, isDark, fgColor]);
}
