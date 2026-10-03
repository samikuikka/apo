"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const AUTO_REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "30s", value: 30000 },
  { label: "1m", value: 60000 },
];

/**
 * Re-runs the current server page in place (`router.refresh()`), keeping
 * client state such as selection, expanded rows and scroll position.
 */
export function useRouterRefresh() {
  const router = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0);

  const refresh = useCallback(() => {
    setIsRefreshing(true);
    router.refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  }, [router]);

  useEffect(() => {
    if (autoRefreshInterval === 0) return;
    // Skip ticks while the tab is hidden — an abandoned background tab on a
    // 30s interval otherwise re-runs the full server page (~720 times/hour).
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, autoRefreshInterval);
    return () => clearInterval(id);
  }, [autoRefreshInterval, router]);

  return { refresh, isRefreshing, autoRefreshInterval, setAutoRefreshInterval };
}

export function RefreshControls({
  label,
  testIdPrefix,
  onRefresh,
  isRefreshing,
  autoRefreshInterval,
  onAutoRefreshChange,
  size = "sm",
}: {
  /** What is refreshed, for the accessible names ("traces", "tasks"). */
  label: string;
  testIdPrefix: string;
  onRefresh: () => void;
  isRefreshing: boolean;
  autoRefreshInterval: number;
  onAutoRefreshChange: (value: number) => void;
  /** `sm` matches h-7 filter bars, `md` the h-8 page toolbars. */
  size?: "sm" | "md";
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRefresh}
        disabled={isRefreshing}
        aria-label={`Refresh ${label}`}
        title={`Refresh ${label}`}
        data-testid={`${testIdPrefix}-refresh`}
        className={cn("p-0", size === "sm" ? "h-7 w-7" : "h-8 w-8")}
      >
        <RefreshCw
          className={cn(size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5", isRefreshing && "animate-spin")}
        />
      </Button>
      <Select value={String(autoRefreshInterval)} onValueChange={(v) => onAutoRefreshChange(Number(v))}>
        <SelectTrigger
          size="sm"
          aria-label="Auto-refresh interval"
          data-testid={`${testIdPrefix}-autorefresh`}
          className={cn(size === "sm" ? "h-7 w-[60px] text-[11px]" : "h-8 w-[64px] text-[12px]")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTO_REFRESH_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={String(o.value)}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
