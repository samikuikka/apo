import { redirect } from "next/navigation";
import { SETTINGS_DEFAULT_SEGMENT } from "./nav-config";

export const metadata = { title: "Settings" };

export default function SettingsIndexPage() {
  redirect(`/settings/${SETTINGS_DEFAULT_SEGMENT}`);
}
