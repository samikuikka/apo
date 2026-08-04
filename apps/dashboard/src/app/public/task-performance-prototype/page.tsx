import { FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { TaskPerformancePrototype } from "@/app/project/[projectId]/tasks/[...taskId]/task-performance-prototype/prototype-ui";

export default async function PublicTaskPerformancePrototype({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string }>;
}) {
  const { variant = "pulse" } = await searchParams;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col">
      <div className="border-b border-border px-6 py-5">
        <span className="text-xs text-muted-foreground">← Tasks</span>
        <div className="mt-1 flex items-center gap-3">
          <FolderOpen className="h-4 w-4 text-primary" />
          <h1 className="text-[18px] font-semibold tracking-tight">Resolve refund request</h1>
          <Badge variant="outline" className="text-[10px]">ai-sdk</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">support/refunds</Badge>
          <Badge variant="outline" className="text-[10px]">2 files</Badge>
          <Badge variant="outline" className="text-[10px]">12 task runs</Badge>
        </div>
      </div>

      <div className="border-b border-border px-6">
        <div className="flex h-10 items-center gap-6 text-[13px]">
          <span className="flex h-full items-center border-b-2 border-foreground font-semibold">Task Run History</span>
          <span className="text-muted-foreground">Files</span>
        </div>
      </div>

      <TaskPerformancePrototype initialVariant={variant} />
    </main>
  );
}
