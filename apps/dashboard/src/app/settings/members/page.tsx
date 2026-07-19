import { SettingsPageHeader } from "@/components/settings/page-header";
import { ProjectMembersSection } from "@/components/project-members/project-members-section";
import { Users } from "lucide-react";

export const metadata = { title: "Members" };

export default function MembersSettingsPage() {
  return (
    <>
      <SettingsPageHeader
        title="Members"
        description="Who can access this project and their role."
        icon={Users}
      />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ProjectMembersSection />
      </div>
    </>
  );
}
