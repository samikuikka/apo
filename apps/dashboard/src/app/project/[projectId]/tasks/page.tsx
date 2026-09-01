import { Suspense } from "react";
import { listAgentTaskBatchRuns, listProjectAgentTasks } from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
import { getProjectOnboardingStatus } from "@/lib/projects-api";
import { StartHereRail } from "@/components/start-here-rail";
import {
  buildCliLoginCommand,
  EXAMPLE_URL,
  HOSTED_DOCS_URL,
  isValidPublicOrigin,
  type ProjectFirstRunSetup,
} from "@/lib/first-run";
import { DEMO_PROJECT } from "@/lib/project-ids";
import { AgentTasksClient } from "./tasks-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tasks" };

export default async function AgentTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  // Arriving via <- Tasks with ?view= re-selects that saved tab.
  const viewRaw = query.view;
  const viewSingle = Array.isArray(viewRaw) ? viewRaw[0] : viewRaw;
  const initialViewId =
    typeof viewSingle === "string" && viewSingle ? viewSingle : null;
  const isDemo = projectId === DEMO_PROJECT;

  let tasks: Awaited<ReturnType<typeof listProjectAgentTasks>> = [];
  let error: string | null = null;
  let taskSource = null;
  // First-run panel inputs — parallel-safe, best-effort. A
  // missing status never breaks the page; it only suppresses onboarding.
  let onboarding: Awaited<ReturnType<typeof getProjectOnboardingStatus>> | null =
    null;

  const [projectResult, statusResult] = await Promise.allSettled([
    getProject(projectId),
    isDemo ? Promise.resolve(null) : getProjectOnboardingStatus(projectId),
  ]);
  let canRunTasks = true;
  if (projectResult.status === "fulfilled") {
    taskSource = projectResult.value.task_source;
    // Viewers (and anonymous demo visitors) never see write affordances —
    // the permission summary is the single source of truth (SPEC-188 U3).
    canRunTasks = projectResult.value.permissions?.can_run_tasks !== false;
  } else {
    error =
      projectResult.reason instanceof Error
        ? projectResult.reason.message
        : "Failed to load project";
  }
  if (statusResult.status === "fulfilled") {
    onboarding = statusResult.value;
  }

  // Every project — demo included — resolves tasks through its
  // configured source inventory. Demo is provisioned with a bundled
  // `demo` source at startup, so it needs no special case.
  if (taskSource !== null && !taskSource.inventory_stale) {
    try {
      tasks = await listProjectAgentTasks(projectId);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
    }
  }

  // The full first-run journey shows only for a genuinely virgin,
  // non-demo Project: nothing published, nothing recorded, no load error.
  // `welcome=1` may highlight it but durable emptiness is the real gate.
  let firstRunSetup: ProjectFirstRunSetup | null = null;
  if (
    !isDemo &&
    !error &&
    onboarding !== null &&
    onboarding.published_task_count === 0 &&
    onboarding.recorded_run_count === 0
  ) {
    const publicUrl = isValidPublicOrigin(onboarding.public_url)
      ? onboarding.public_url
      : "";
    firstRunSetup = {
      publicUrl,
      projectId,
      cliLoginCommand: publicUrl ? buildCliLoginCommand(publicUrl, projectId) : "",
      docsUrl: HOSTED_DOCS_URL,
      exampleUrl: EXAMPLE_URL,
    };
  }

  // The demo guide rail's honesty footer needs the capture date: the
  // newest completed batch. Best-effort — an empty demo just hides the date.
  let capturedOn = "";
  if (isDemo) {
    try {
      const batches = await listAgentTaskBatchRuns(projectId, { page_size: 100 });
      capturedOn =
        (batches.data ?? [])
          .flatMap((b) => {
            const stamp = b.completed_at ?? b.created_at;
            return stamp ? [stamp] : [];
          })
          .sort()
          .at(-1)
          ?.slice(0, 10) ?? "";
    } catch {
      capturedOn = "";
    }
  }

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        {/* The client reads ?view= via useSearchParams, which needs a Suspense
            boundary — without one, Next.js forces the page into client-side
            rendering. The boundary content renders on the server for dynamic
            pages, so the fallback only shows during client-side navigation. */}
        <Suspense fallback={null}>
          <AgentTasksClient
            tasks={tasks}
            error={error}
            taskSource={taskSource}
            isDemo={isDemo}
            canRunTasks={canRunTasks}
            firstRunSetup={firstRunSetup}
            initialViewId={initialViewId}
          />
        </Suspense>
      </div>
      {isDemo && capturedOn ? <StartHereRail capturedOn={capturedOn} /> : null}
    </div>
  );
}
