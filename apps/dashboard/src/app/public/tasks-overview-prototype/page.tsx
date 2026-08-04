import { BarChart3, Play, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TasksOverviewPrototype } from "@/app/project/[projectId]/tasks/tasks-overview-prototype/prototype-ui";

export default async function PublicTasksOverviewPrototype({ searchParams }: { searchParams: Promise<{ variant?: string }> }) {
  const { variant = "modes" } = await searchParams;
  return (
    <main className="mx-auto w-full max-w-7xl">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border px-6 py-5">
        <div><div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-muted-foreground" /><h1 className="text-[18px] font-semibold tracking-tight">Tasks</h1></div><div className="mt-1 text-xs text-muted-foreground">7 published Tasks · 3 folders</div></div>
        <div className="flex items-center gap-2"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="Search Tasks" placeholder="Search Tasks" className="h-8 w-52 pl-8 text-xs" /></div><Button type="button" className="h-8 text-xs"><Play className="h-3.5 w-3.5 fill-current" />Run Tasks</Button></div>
      </header>
      <TasksOverviewPrototype initialVariant={variant} />
    </main>
  );
}
