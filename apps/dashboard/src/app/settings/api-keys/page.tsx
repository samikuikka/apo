"use client";

import { SettingsPageHeader } from "@/components/settings/page-header";
import { ApiKeysSection } from "@/components/admin/api-keys-section";
import { KeyRound } from "lucide-react";

export default function ApiKeysSettingsPage() {
  return (
    <>
      <SettingsPageHeader
        title="API Keys"
        description="Keys used by the SDK and CLI to authenticate against the backend."
        icon={KeyRound}
      />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <ApiKeysSection />
      </div>
    </>
  );
}
