import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listProjects } from "@/lib/projects-api";
import { isApiError } from "@/lib/api-error";
import { DashboardEmptyState } from "@/components/dashboard-empty-state";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();

  if (session) {
    let owned: { id: string }[] = [];
    try {
      const projects = await listProjects();
      owned = projects.filter((p) => p.id !== "demo");
    } catch (error) {
      // This is a Server Component, so we can't toast. Fall through to the
      // empty state for the user, but log the real reason — without this a
      // dead backend, a 404, or an auth failure looks identical to a genuine
      // empty account, which is exactly why outages used to go undiagnosed.
      // Clients with devtools open see it in the server console.
      console.error(
        "[home] listProjects failed; rendering empty state:",
        isApiError(error) ? `HTTP ${error.status}: ${error.message}` : error,
      );
    }
    if (owned.length > 0) {
      redirect(`/project/${owned[0]!.id}/tasks`);
    }
  }

  return <DashboardEmptyState />;
}
