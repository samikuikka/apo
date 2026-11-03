import { Button } from "@/components/ui/button";
import { HOSTED_DOCS_URL } from "@/lib/first-run";

const QUICKSTART_URL = new URL("/quickstart/", HOSTED_DOCS_URL).href;

/**
 * The demo tasks page's opening line for an anonymous visitor: name what
 * they are looking at (a frozen capture, nothing here is runnable) and
 * hand them the one next step, testing their own agent via the docs.
 */
export function DemoReadOnlyBanner() {
  return (
    <div
      data-testid="demo-read-only-banner"
      className="mx-6 mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground"
    >
      <p className="min-w-0">
        This workspace is a read-only capture. To test{" "}
        <span className="font-medium text-foreground">your</span> agent, start
        here.
      </p>
      <Button type="button" asChild className="shrink-0">
        <a href={QUICKSTART_URL} target="_blank" rel="noreferrer">
          Quickstart
        </a>
      </Button>
    </div>
  );
}
