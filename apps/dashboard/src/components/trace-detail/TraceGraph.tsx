"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Network } from "vis-network/standalone";
import type { LoggedCall } from "./contexts";
import { useSelection } from "./contexts/SelectionContext";
import { useGraphData } from "./graph/useGraphData";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TraceGraphProps {
  calls: LoggedCall[];
}

function getThemeColors() {
  if (typeof document === "undefined") {
    return { bg: "#ffffff", fg: "#1e293b", border: "#e2e8f0" };
  }
  const root = document.documentElement;
  const bg = getComputedStyle(root).getPropertyValue("--background").trim();
  const fg = getComputedStyle(root).getPropertyValue("--foreground").trim();
  const border = getComputedStyle(root).getPropertyValue("--border").trim();
  return {
    bg: bg || "#ffffff",
    fg: fg || "#1e293b",
    border: border || "#e2e8f0",
  };
}

function useIsDarkMode() {
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

export function TraceGraph({ calls }: TraceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const isDark = useIsDarkMode();
  const { nodes, edges } = useGraphData(calls, isDark);
  const { selectCall, selectedCallId } = useSelection();
  const [_isFit, setIsFit] = useState(true);

  const getNetworkOptions = useCallback(() => {
    const theme = getThemeColors();
    return {
      nodes: {
        shape: "box",
        font: {
          size: 20,
          face: "Inter, system-ui, sans-serif",
          color: theme.fg,
        },
        margin: {
          top: 16,
          right: 20,
          bottom: 16,
          left: 20,
        },
        widthConstraint: {
          maximum: 300,
        },
        color: {
          background: theme.bg,
          border: theme.border,
          highlight: {
            background: isDark ? "#1e3a5f" : "#eff6ff",
            border: "#3b82f6",
          },
          hover: {
            background: isDark ? "#1e293b" : "#f8fafc",
            border: isDark ? "#475569" : "#cbd5e1",
          },
        },
      },
      edges: {
        smooth: {
          enabled: true,
          type: "cubicBezier",
          forceDirection: "vertical",
          roundness: 0.4,
        },
        arrows: {
          to: {
            enabled: true,
            scaleFactor: 1.2,
          },
        },
        color: {
          color: "#94a3b8",
          highlight: "#3b82f6",
          hover: "#64748b",
        },
        width: 2,
      },
      layout: {
        hierarchical: {
          enabled: true,
          direction: "UD",
          sortMethod: "directed",
          levelSeparation: 120,
          nodeSpacing: 100,
          treeSpacing: 180,
        },
      },
      physics: {
        enabled: true,
        hierarchicalRepulsion: {
          nodeDistance: 150,
        },
        stabilization: {
          iterations: 200,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        navigationButtons: false,
        keyboard: true,
      },
    };
  }, [isDark]);

  useEffect(() => {
    if (!containerRef.current) return;

    if (calls.length === 0) return;

    const network = new Network(
      containerRef.current,
      { nodes, edges },
      getNetworkOptions()
    );

    network.on("click", (params) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        if (nodeId !== "root") {
          selectCall(nodeId);
        } else {
          selectCall(null);
        }
      }
    });

    network.on("hoverNode", () => {
      if (containerRef.current) {
        containerRef.current.style.cursor = "pointer";
      }
    });

    network.on("blurNode", () => {
      if (containerRef.current) {
        containerRef.current.style.cursor = "default";
      }
    });

    network.once("stabilizationIterationsDone", () => {
      network.fit({
        animation: {
          duration: 500,
          easingFunction: "easeInOutQuad",
        },
      });
    });

    networkRef.current = network;

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, [calls.length, nodes, edges, selectCall, getNetworkOptions]);

  useEffect(() => {
    if (networkRef.current) {
      networkRef.current.setData({ nodes, edges });
    }
  }, [nodes, edges]);

  useEffect(() => {
    if (!networkRef.current || !selectedCallId) return;

    networkRef.current.selectNodes([selectedCallId]);
    networkRef.current.fit({
      animation: {
        duration: 300,
        easingFunction: "easeInOutQuad",
      },
    });
  }, [selectedCallId]);

  const handleFit = () => {
    if (networkRef.current) {
      networkRef.current.fit({
        animation: {
          duration: 500,
          easingFunction: "easeInOutQuad",
        },
      });
      setIsFit(true);
    }
  };

  if (calls.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="text-center text-sm text-muted-foreground">
          <p className="mb-2 font-medium">No calls</p>
          <p>This run has no logged calls to visualize.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-background">
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <Button type="button"
          variant="secondary"
          size="sm"
          onClick={handleFit}
          className="h-7 px-2 text-xs"
          title="Fit to view"
        >
          <Maximize2 className="h-3 w-3" />
        </Button>
      </div>

      <div
        ref={containerRef}
        className={cn(
          "h-full w-full min-h-[400px]",
          "transition-opacity duration-200"
        )}
      />
    </div>
  );
}
