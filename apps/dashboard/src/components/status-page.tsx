import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const WRAPPER_BG =
  "bg-[radial-gradient(circle_at_top,_rgba(120,119,198,0.12),transparent_40%),linear-gradient(to_bottom,_#080b14,_#05070d_55%,#05060c)]";

interface StatusPageProps {
  /** Eyebrow label, e.g. "404" or "Error". */
  badge: string;
  /** Leading icon element (pass a lucide icon with sizing/color). */
  icon: ReactNode;
  /** Card title. */
  title: string;
  /** Body copy explaining what happened / what to do. */
  description: ReactNode;
  /** Optional action row / detail block rendered below the description. */
  children?: ReactNode;
  /** Override the wrapper height (e.g. "min-h-screen" when no TopNav is present). */
  className?: string;
}

/**
 * Full-page status surface (404 / error / global-error). Renders the shared
 * gradient background + Card + Badge eyebrow + icon + title + body. Animation-free.
 */
export function StatusPage({
  badge,
  icon,
  title,
  description,
  children,
  className,
}: StatusPageProps) {
  return (
    <div
      className={cn(
        "flex min-h-[calc(100vh-5rem)] items-center justify-center px-6 py-12 text-foreground",
        WRAPPER_BG,
        className,
      )}
    >
      <Card className="w-full max-w-xl border-border/70 bg-card/80 shadow-2xl shadow-black/40 backdrop-blur">
        <CardHeader className="space-y-4">
          <Badge
            variant="outline"
            className="w-fit border-border/60 bg-muted/20 text-[11px] uppercase tracking-[0.3em] text-muted-foreground"
          >
            {badge}
          </Badge>
          <div className="flex items-center gap-3">
            {icon}
            <CardTitle className="text-[18px] font-semibold">{title}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p className="text-base text-foreground">{description}</p>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}
