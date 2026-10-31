import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPage } from "@/components/status-page";

interface DashboardLoadErrorProps {
  /** Underlying failure reason, when known, shown for diagnosis. */
  detail?: string | null;
}

/**
 * Home-page load failure: the projects fetch failed (backend unreachable,
 * wrong port, or expired session), which is not the same as having zero
 * projects. Rendered instead of the create-project empty state so an outage
 * reads as an error, never as a fresh account.
 */
export function DashboardLoadError({ detail }: DashboardLoadErrorProps) {
  return (
    <StatusPage
      badge="Error"
      icon={<AlertTriangle className="size-8 text-primary" />}
      title="Could not load your projects"
      description="The apo backend could not be reached, or your session expired. Retry in case it was transient; sign in again if it keeps failing."
    >
      {detail ? (
        <div className="rounded-none border border-border/60 bg-background/80 px-3 py-2 font-mono text-xs text-muted-foreground">
          {detail}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" asChild>
          <Link href="/">
            <RotateCw className="size-4" />
            Retry
          </Link>
        </Button>
        <Button type="button" asChild variant="outline">
          <Link href="/login">Sign in again</Link>
        </Button>
      </div>
    </StatusPage>
  );
}
