import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listProjects } from "@/lib/projects-api";
import { DashboardEmptyState } from "@/components/dashboard-empty-state";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();

  if (session) {
    let owned: { id: string }[] = [];
    try {
      const projects = await listProjects();
      owned = projects.filter((p) => p.id !== "demo");
    } catch {
      // If the fetch fails, fall through to the empty state.
    }
    if (owned.length > 0) {
      redirect(`/project/${owned[0]!.id}/tasks`);
    }
  }

  return <DashboardEmptyState />;
}
