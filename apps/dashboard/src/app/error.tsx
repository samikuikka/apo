"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPage } from "@/components/status-page";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      badge="Error"
      icon={<AlertTriangle className="size-8 text-primary" />}
      title="Something went wrong"
      description="An unexpected error occurred while loading this page. You can try again or head back to the dashboard."
    >
      {error?.message ? (
        <div className="rounded-none border border-border/60 bg-background/80 px-3 py-2 font-mono text-xs text-muted-foreground">
          {error.message}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={reset}>
          <RotateCw className="size-4" />
          Retry
        </Button>
        <Button type="button" asChild variant="outline">
          <Link href="/">Back to dashboard</Link>
        </Button>
      </div>
    </StatusPage>
  );
}
