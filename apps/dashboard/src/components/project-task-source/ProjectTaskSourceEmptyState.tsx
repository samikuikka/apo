"use client";

import Link from "next/link";
import { Boxes, CalendarClock, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type EmptyStateScope = "tasks" | "batch-runs" | "schedules";

interface ProjectTaskSourceEmptyStateProps {
  projectId: string;
  scope: Exclude<EmptyStateScope, "tasks">;
  className?: string;
}

interface ScopeCopy {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}

function copyForScope(scope: Exclude<EmptyStateScope, "tasks">): ScopeCopy {
  if (scope === "batch-runs") {
    return {
      icon: Boxes,
      title: "Batch runs start from synced tasks",
      body: "Connect a task source on the tasks page, then sync. Batch runs will pick from that inventory.",
    };
  }
  return {
    icon: CalendarClock,
    title: "Schedules need synced tasks",
    body: "Schedules run against your project's task inventory. Connect a task source first, then create schedules.",
  };
}

export function ProjectTaskSourceEmptyState({
  projectId,
  scope,
  className,
}: ProjectTaskSourceEmptyStateProps) {
  const copy = copyForScope(scope);
  const Icon = copy.icon;
  const tasksHref = `/project/${projectId}/tasks`;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-16 text-center",
        className,
      )}
    >
      <Icon className="size-5 text-muted-foreground/40" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="mx-auto max-w-sm text-xs text-muted-foreground">
          {copy.body}
        </p>
      </div>
      <Button type="button" asChild size="sm" variant="outline">
        <Link href={tasksHref}>
          Set up task source
          <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}
