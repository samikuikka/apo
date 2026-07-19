"use client";

import Link from "next/link";
import { Play } from "lucide-react";
import { type AgentTaskRunSummary } from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";
import { TaskRunListHeader, TaskRunRow } from "@/components/task-run-list";

import { useProjectId } from "@/lib/project-router";
interface TaskRunHistoryProps {
  runs: AgentTaskRunSummary[];
}

export function TaskRunHistory({ runs }: TaskRunHistoryProps) {
  const projectId = useProjectId();
  if (!runs || runs.length === 0) {
    return (
      <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
        No runs yet.{" "}
        <Link href={`/project/${projectId}/tasks`} className="underline underline-offset-4 hover:text-foreground">
          Run this task
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <span className="text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">{runs.length}</span> task runs
        </span>
        <Button type="button" asChild size="sm" className="h-7 gap-1.5 text-[12px] font-medium">
          <Link href={`/project/${projectId}/tasks`}>
            <Play className="h-3 w-3 fill-current" />
            Run again
          </Link>
        </Button>
      </div>

      <TaskRunListHeader />

      <div className="divide-y divide-border">
        {runs.map((run) => (
          <TaskRunRow key={run.id} run={run} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}
