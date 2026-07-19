/**
 * Route-integrity guard for the Settings section.
 *
 * This test exists to prevent the regression where navigating to
 * `/settings/profile` (or any linked settings page) 404'd because the
 * `page.tsx` was deleted while the nav links and the `/settings` redirect
 * still pointed at it.
 *
 * It treats `nav-config.ts` as the single source of truth: every nav entry,
 * the index redirect target, and the user-menu link must resolve to a real
 * route segment on disk.
 */
import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ALL_SETTINGS_ITEMS,
  PERSONAL_ITEMS,
  PROJECT_ITEMS,
  INSTANCE_ITEMS,
  SETTINGS_DEFAULT_SEGMENT,
  settingsHref,
} from "../nav-config";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname is .../app/settings/__tests__ — the settings app dir is two levels up.
const SETTINGS_DIR = join(__dirname, "..");

describe("settings route integrity", () => {
  // Sanity: if this constant ever stops being "profile" (or whichever segment
  // we default to), make sure that segment is actually wired up in the nav.
  it("the default redirect segment exists as a nav entry", () => {
    const segments = ALL_SETTINGS_ITEMS.map((i) => i.segment);
    expect(segments, `nav entries: ${segments.join(", ")}`).toContain(
      SETTINGS_DEFAULT_SEGMENT,
    );
  });

  it("every nav entry has a matching page.tsx on disk", () => {
    const missing = ALL_SETTINGS_ITEMS.filter(
      (item) => !existsSync(join(SETTINGS_DIR, item.segment, "page.tsx")),
    ).map(settingsHref);

    expect(
      missing,
      `Settings pages deleted but still linked from the sidebar: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no orphaned page.tsx dirs that the nav never reaches", () => {
    const navSegments = new Set(ALL_SETTINGS_ITEMS.map((i) => i.segment));
    const onDisk = readdirSync(SETTINGS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(join(SETTINGS_DIR, name, "page.tsx")));

    const orphans = onDisk.filter((name) => !navSegments.has(name));
    expect(
      orphans,
      `Settings pages with no nav entry (unreachable via sidebar): ${orphans.join(", ")}`,
    ).toEqual([]);
  });

  // Group invariants: if someone deletes a whole group, ALL_SETTINGS_ITEMS
  // below must stay in sync with the union of the three groups.
  it("ALL_SETTINGS_ITEMS is the exact union of the three groups", () => {
    const union = [
      ...PERSONAL_ITEMS,
      ...PROJECT_ITEMS,
      ...INSTANCE_ITEMS,
    ].map((i) => i.segment);
    const all = ALL_SETTINGS_ITEMS.map((i) => i.segment);
    expect(all).toEqual(union);
  });

  it("settingsHref derives /settings/<segment> and is stable", () => {
    for (const item of ALL_SETTINGS_ITEMS) {
      expect(settingsHref(item)).toBe(`/settings/${item.segment}`);
    }
  });

  it("admin-only gating is only applied to instance items", () => {
    const nonInstanceAdmin = [
      ...PERSONAL_ITEMS,
      ...PROJECT_ITEMS,
    ].filter((i) => i.adminOnly);
    expect(nonInstanceAdmin, "adminOnly should only appear on instance items").toEqual([]);
  });
});
