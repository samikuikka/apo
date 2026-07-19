/**
 * Single source of truth for the Settings sub-pages.
 *
 * The sidebar nav, the `/settings` index redirect, and the route-integrity
 * test all read from this config. That coupling is intentional: you cannot
 * add a nav entry (or delete a page) without the test forcing the matching
 * `app/settings/<segment>/page.tsx` to exist — which prevents the
 * "click Settings → 404" regression this module was introduced to guard.
 */
import { KeyRound, LucideIcon, MonitorSmartphone, Settings, User, Users } from "lucide-react";

export type SettingsNavItem = {
  label: string;
  /** App-router segment under `/settings`, e.g. "profile" → /settings/profile. */
  segment: string;
  icon: LucideIcon;
  adminOnly?: boolean;
};

/** `href` is derived from `segment` so the two can never drift apart. */
export function settingsHref(item: SettingsNavItem): string {
  return `/settings/${item.segment}`;
}

// SPEC-122: instance-maintenance screens stay hidden/dev-only. They are
// not part of normal product roles. Project member management lives
// alongside API Keys in the project settings group below.
export const PERSONAL_ITEMS: SettingsNavItem[] = [
  { label: "Profile", segment: "profile", icon: User },
  { label: "Sessions", segment: "sessions", icon: MonitorSmartphone },
];

export const PROJECT_ITEMS: SettingsNavItem[] = [
  { label: "API Keys", segment: "api-keys", icon: KeyRound },
  { label: "Members", segment: "members", icon: Users },
];

export const INSTANCE_ITEMS: SettingsNavItem[] = [
  { label: "System", segment: "system", icon: Settings, adminOnly: true },
];

/** Every route the settings UI can navigate to. */
export const ALL_SETTINGS_ITEMS: SettingsNavItem[] = [
  ...PERSONAL_ITEMS,
  ...PROJECT_ITEMS,
  ...INSTANCE_ITEMS,
];

/** The page `/settings` itself redirects here. Must always resolve. */
export const SETTINGS_DEFAULT_SEGMENT = "profile";
