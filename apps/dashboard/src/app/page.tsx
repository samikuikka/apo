import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listProjects } from "@/lib/projects-api";
import { isApiError } from "@/lib/api-error";
import { getServerBackendBaseUrl } from "@/lib/config.server";
import { DashboardEmptyState } from "@/components/dashboard-empty-state";
import { DashboardLoadError } from "@/components/dashboard-load-error";
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

/** One-line reason for the load-error detail block and server log. */
function describeLoadFailure(error: unknown): string {
  if (isApiError(error)) return `HTTP ${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
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

  let owned: { id: string }[] = [];
  let loadDetail: string | null = null;
  try {
    const projects = await listProjects();
    owned = projects.filter((p) => p.id !== "demo");
  } catch (error) {
    // A failed fetch is an outage (dead backend, wrong port, expired
    // session), not an empty account: surface an error state, and keep the
    // reason in the server console for operators reading container logs.
    loadDetail = describeLoadFailure(error);
    console.error("[home] listProjects failed; rendering error state:", error);
  }
  if (loadDetail !== null) {
    return <DashboardLoadError detail={loadDetail} />;
  }
  if (owned.length > 0) {
    redirect(`/project/${owned[0]!.id}/tasks`);
  }

  return <DashboardEmptyState />;
}
