"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { buttonVariants } from "@/components/ui/button-variants";
import { cn } from "@/lib/utils";
import { useProjectId } from "@/lib/project-router";
import type { MouseEventHandler } from "react";

interface TraceHomeLinkProps {
  traceId: string;
  label?: string;
  className?: string;
  appearance?: "button" | "tab" | "inline" | "card";
  buttonVariant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "link";
  buttonSize?: "default" | "xs" | "sm" | "lg";
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}

export function TraceHomeLink({
  traceId,
  label = "Trace home",
  className,
  appearance = "inline",
  buttonVariant = "outline",
  buttonSize = "sm",
  onClick,
}: TraceHomeLinkProps) {
  const projectId = useProjectId();
  const href = `/project/${projectId}/traces/${traceId}`;

  if (appearance === "button") {
    return (
      <Link
        href={href}
        onClick={onClick}
        className={cn(
          buttonVariants({ variant: buttonVariant, size: buttonSize }),
          className,
        )}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {label}
      </Link>
    );
  }

  if (appearance === "tab") {
    return (
      <Link
        href={href}
        onClick={onClick}
        className={cn(
          "relative inline-flex h-9 items-center gap-1.5 px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        <ExternalLink className="h-3.5 w-3.5" />
        {label}
      </Link>
    );
  }

  if (appearance === "card") {
    return (
      <Link
        href={href}
        onClick={onClick}
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border/50 p-2 transition-colors hover:bg-muted/30",
          className,
        )}
      >
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{label}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{traceId}</div>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:underline",
        className,
      )}
    >
      {label}
      <ExternalLink className="h-2.5 w-2.5" />
    </Link>
  );
}
