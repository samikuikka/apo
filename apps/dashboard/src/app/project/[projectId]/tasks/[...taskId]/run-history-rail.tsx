"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

import {
  ScopeRail,
  ScopeRailSheet,
  useRailSheetOpen,
  useRailVisible,
} from "@/components/run-scope-rail";
import { useIsMobile } from "@/hooks/use-mobile";
import type { RunLabelFacets } from "@/lib/agent-task-api";
import {
  parseRunScope,
  writeRunScope,
  type RunScope,
} from "@/lib/run-scope";

/**
 * The task run-history's scope rail: the same sidebar the Runs page uses,
 * wrapped around this page's content. The scope bar's Filters toggle drives
 * it through the shared remembered-visibility state, so the two components
 * can live on either side of the page's server/client boundary. Scope writes
 * rewrite the same `?environment=&label=` params the bar owns, preserving
 * every other parameter (`view` identity included).
 */
export function RunHistoryRail({
  labelFacets,
  children,
}: {
  labelFacets: RunLabelFacets | null;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [railOpen, setRailOpen] = useRailVisible();
  const [sheetOpen, setSheetOpen] = useRailSheetOpen();
  const isMobile = useIsMobile();

  const scope = parseRunScope(searchParams);
  const onScopeChange = (next: RunScope) => {
    const params = new URLSearchParams(searchParams.toString());
    writeRunScope(params, next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className={isMobile || !railOpen ? "flex flex-col" : "flex flex-row"}>
      <ScopeRailSheet
        facets={labelFacets}
        scope={scope}
        onScopeChange={onScopeChange}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
      />
      {!isMobile && railOpen && (
        <ScopeRail
          facets={labelFacets}
          scope={scope}
          onScopeChange={onScopeChange}
          onClose={() => setRailOpen(false)}
        />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
