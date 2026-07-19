"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusPage } from "@/components/status-page";

export default function GlobalError({
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
    <html lang="en" className="dark">
      <body className="antialiased">
        <StatusPage
          className="min-h-screen"
          badge="Error"
          icon={<AlertTriangle className="size-8 text-primary" />}
          title="Something went wrong"
          description="The application failed to load. Try again, or reload the page."
        >
          {error?.message ? (
            <div className="rounded-none border border-border/60 bg-background/80 px-3 py-2 font-mono text-xs text-muted-foreground">
              {error.message}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={reset}>
              <RotateCw className="size-4" />
              Try again
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => window.location.reload()}
            >
              Reload page
            </Button>
          </div>
        </StatusPage>
      </body>
    </html>
  );
}
