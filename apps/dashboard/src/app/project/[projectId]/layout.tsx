import { notFound, redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";
import { ProjectAccessDenied } from "@/components/project-access-denied";
import { isForbidden, isNotFoundStatus, isUnauthorized } from "@/lib/api-error";
import { getProject } from "@/lib/projects-api";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  // Centralized access guard: every project sub-route inherits this check.
  // The backend distinguishes 401 (not authenticated), 403 (not a member),
  // and 404 (project missing); we translate each into the matching
  // full-page state instead of letting individual pages re-derive it.
  try {
    await getProject(projectId);
  } catch (error) {
    if (isUnauthorized(error)) {
      redirect("/login");
    }
    if (isNotFoundStatus(error)) {
      notFound();
    }
    if (isForbidden(error)) {
      return <ProjectAccessDenied projectId={projectId} />;
    }
    throw error;
  }

  return <DashboardShell projectId={projectId}>{children}</DashboardShell>;
}
