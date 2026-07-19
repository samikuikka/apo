import { SettingsSidebar } from "@/components/settings-sidebar";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] overflow-hidden">
      <SettingsSidebar />
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
