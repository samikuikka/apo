import { auth } from "@/auth";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { SystemSection } from "@/components/admin/system-section";
import { ProjectResetSection } from "@/components/admin/project-reset-section";
import { SystemRuntimePanel } from "@/components/system-runtime-panel";
import { TaskRuntimeStatusPanel } from "@/components/task-runtime-status-panel";
import {
  fetchReadinessReport,
  fetchRuntimeConfig,
  fetchTaskRuntimeStatus,
} from "@/lib/system-api";
import { ShieldAlert } from "lucide-react";

export const metadata = {
  title: "System",
  description: "Internal system operations for the agent-testing platform",
};

export default async function SystemSettingsPage() {
  const session = await auth();
  const isAdmin = session?.user?.is_admin === true;

  if (!isAdmin) {
    return (
      <>
        <SettingsPageHeader title="System" description="Internal system operations" icon={ShieldAlert} />
        <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-muted-foreground">
          Administrator access required.
        </div>
      </>
    );
  }

  // Fetch initial panel data server-side so the client panels don't need a
  // mount-init fetch. Each request is best-effort: on failure we leave the
  // prop null so the panel renders its empty state and the user can Retry.
  const [configResult, readinessResult, statusResult] = await Promise.allSettled([
    fetchRuntimeConfig(),
    fetchReadinessReport(),
    fetchTaskRuntimeStatus(),
  ]);
  const initialConfig =
    configResult.status === "fulfilled" ? configResult.value : null;
  const initialReadiness =
    readinessResult.status === "fulfilled" ? readinessResult.value : null;
  const initialStatus =
    statusResult.status === "fulfilled" ? statusResult.value : null;

  return (
    <>
      <SettingsPageHeader
        title="System"
        description="Internal system operations for the agent-testing platform."
        icon={ShieldAlert}
      />
      <SystemRuntimePanel
        initialConfig={initialConfig}
        initialReadiness={initialReadiness}
      />
      <div className="mt-6">
        <TaskRuntimeStatusPanel initialStatus={initialStatus} />
      </div>
      <div className="mt-6">
        <SystemSection />
      </div>
      <div className="mt-6">
        <ProjectResetSection />
      </div>
    </>
  );
}
