"use client";

import { Coins } from "lucide-react";

import { SettingsPageHeader } from "@/components/settings/page-header";
import { ProjectRepriceSection } from "@/components/settings/project-reprice-section";

export default function CostsSettingsPage() {
  return (
    <>
      <SettingsPageHeader
        title="Costs"
        description="Recompute a project's stored run costs against the current model prices."
        icon={Coins}
      />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ProjectRepriceSection />
      </div>
    </>
  );
}
