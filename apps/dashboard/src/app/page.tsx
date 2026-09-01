import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listProjects } from "@/lib/projects-api";
import { isApiError } from "@/lib/api-error";
import { getServerBackendBaseUrl } from "@/lib/config.server";
import { DashboardEmptyState } from "@/components/dashboard-empty-state";
import { DemoLanding } from "@/components/demo-landing";

export const dynamic = "force-dynamic";

async function devSigninEnabled(): Promise<boolean> {
  try {
    const res = await fetch(
      `${getServerBackendBaseUrl()}/auth/dev-signin/available`,
      { cache: "no-store" },
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.enabled === true;
  } catch {
    return false;
  }
}

export default async function Home() {
  const session = await auth();

  // Dev sign-in deployments: an unauthenticated visitor goes to
  // the login page where the one-click dev button waits, instead of the
  // empty state that assumes human onboarding.
  if (!session && (await devSigninEnabled())) {
    redirect("/login");
  }

  // Anonymous visitors get the demo-forward landing: stat
  // cards from the fixture, one CTA, no account, no seed call.
  if (!session) {
    return <DemoLanding />;
  }

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
