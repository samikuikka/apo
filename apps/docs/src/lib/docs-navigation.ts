/**
 * apo docs navigation — the single source of truth for the four top-level
 * sections (Guide / Reference / CLI / Ecosystem) and the sidebar groups
 * each one owns.
 *
 * Modeled on flue's docs-navigation.ts: section = a header tab + its own
 * sidebar slice. `astro.config.mjs` still holds the flattened union of every
 * group (so Starlight's search + pagination see all pages); the Sidebar
 * override filters that union down to the active section using the group
 * labels declared here.
 *
 * Adding a page: create the .md/.mdx, add its slug to a group below, and add
 * a `{ label, slug }` entry to the matching group in astro.config.mjs. The
 * group `label` string is what ties the two together.
 */

export type DocsSectionKey = "guide" | "reference" | "cli" | "ecosystem";

export interface DocsSection {
  /** Internal key + active-tab matcher. */
  key: DocsSectionKey;
  /** Header-tab label. */
  title: string;
  /** Slug the tab links to (the section's first/landing page). */
  landingSlug: string;
  /**
   * Sidebar group labels that belong to this section. These strings must
   * match the `label` fields in astro.config.mjs's sidebar config exactly —
   * the Sidebar override filters the built sidebar by them.
   */
  groups: string[];
}

export const docsSections: DocsSection[] = [
  {
    key: "guide",
    title: "Guide",
    landingSlug: "overview",
    groups: ["Getting Started", "Concepts", "Guides", "Self-Hosting"],
  },
  {
    key: "reference",
    title: "Reference",
    landingSlug: "reference/overview",
    groups: ["Reference"],
  },
  {
    key: "cli",
    title: "CLI",
    landingSlug: "cli",
    groups: ["CLI"],
  },
  {
    key: "ecosystem",
    title: "Ecosystem",
    landingSlug: "ecosystem",
    groups: ["Ecosystem"],
  },
];

/**
 * Minimal shape of Starlight's built sidebar — enough to find the current
 * page's owning group without depending on Starlight's internal types (which
 * aren't exported from the public surface). The Sidebar override passes its
 * already-built `Astro.locals.starlightRoute.sidebar` here.
 */
interface BuiltSidebarEntry {
  type: "link" | "group";
  isCurrent?: boolean;
  label?: string;
  href?: string;
  entries?: BuiltSidebarEntry[];
}

/**
 * Check whether a sidebar entry's href points to the same page as the given
 * pathname. Strips the hash from the entry href (anchor links like
 * /reference/running/#runtaskoptions) and compares the path portion.
 */
function hrefMatchesPath(entry: BuiltSidebarEntry, pathname: string): boolean {
  if (entry.type !== "link" || !entry.href) return false;
  const pathPart = entry.href.split("#")[0];
  return (
    encodeURI(pathPart).replace(/\/$/, "") ===
    encodeURI(pathname).replace(/\/$/, "")
  );
}

/**
 * Which section owns the current page. Starlight marks `isCurrent` on slug-
 * based entries, but `link`-based entries with anchors (e.g. method links
 * like /reference/running/#runtaskoptions) never get isCurrent because
 * Starlight compares pathnames without hashes. So we also match by href
 * path to catch those.
 * Searches recursively so nested sub-groups resolve to their parent section.
 * Falls back to guide (the default section).
 */
function containsCurrent(entry: BuiltSidebarEntry, pathname?: string): boolean {
  if (entry.type === "link") {
    if (entry.isCurrent) return true;
    if (pathname && hrefMatchesPath(entry, pathname)) return true;
  }
  if (entry.type === "group" && entry.entries) {
    return entry.entries.some((e) => containsCurrent(e, pathname));
  }
  return false;
}

export function getDocsSection(
  sidebar: BuiltSidebarEntry[],
  pathname?: string,
): DocsSection {
  for (const entry of sidebar) {
    if (entry.type === "group" && entry.entries) {
      if (entry.entries.some((e) => containsCurrent(e, pathname))) {
        const section = docsSections.find((s) =>
          s.groups.includes(entry.label ?? ""),
        );
        if (section) return section;
      }
    }
  }
  return docsSections[0];
}

/**
 * Filter a built sidebar to only the groups owned by a section. Used by the
 * Sidebar override so each section renders only its own slice.
 */
export function filterSidebarBySection(
  sidebar: BuiltSidebarEntry[],
  section: DocsSection,
): BuiltSidebarEntry[] {
  return sidebar.filter(
    (entry) => entry.type === "group" && section.groups.includes(entry.label ?? ""),
  );
}

/** Build a `/slug/` href with optional in-page anchor. */
export function docsHref(slug: string, anchor?: string): string {
  return `/${slug}/${anchor ? `#${anchor}` : ""}`;
}
