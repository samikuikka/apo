import type { ReactNode } from "react";
import { Calendar, FlaskConical, Layers, Waypoints } from "lucide-react";
import { Img, staticFile } from "remotion";
import { color } from "../theme";
import { fontFamilies } from "../fonts";

export type AppNav = "tasks" | "runs" | "schedules" | "traces";

const NAV: { group: string; items: { id: AppNav; label: string; icon: typeof Layers }[] }[] = [
  {
    group: "Agent Testing",
    items: [
      { id: "tasks", label: "Tasks", icon: FlaskConical },
      { id: "runs", label: "Runs", icon: Layers },
      { id: "schedules", label: "Schedules", icon: Calendar },
    ],
  },
  {
    group: "Observability",
    items: [{ id: "traces", label: "Traces", icon: Waypoints }],
  },
];

type AppFrameProps = {
  /**
   * "app" = the full dashboard (top nav + sidebar). "window" = a product
   * surface without the sidebar — browser bar + breadcrumb only, for scene
   * stages that sit beside other content.
   */
  variant?: "app" | "window";
  /** Which sidebar item is active — usually the beat's stage. */
  activeNav?: AppNav;
  /** Breadcrumb after the workspace name, e.g. "Runs". */
  breadcrumb: string;
  /** Rendered width of the whole window in px. */
  width?: number;
  children: ReactNode;
  /** Height of the content area. */
  contentHeight?: number;
};

/**
 * The apo dashboard as a video prop: browser bar, top nav with the brand
 * mark, the real sidebar (Agent Testing / Observability groups, same icons),
 * and a breadcrumb header — the product chrome that says "this is apo"
 * before any content renders.
 */
export const AppFrame = ({
  variant = "app",
  activeNav,
  breadcrumb,
  width = 1660,
  contentHeight = 560,
  children,
}: AppFrameProps) => {
  const activeLabel =
    activeNav !== undefined
      ? NAV.flatMap((g) => g.items).find((item) => item.id === activeNav)?.label
      : breadcrumb;
  const slim = variant === "window";
  return (
    <div
      style={{
        width,
        borderWidth: 1.5,
        borderStyle: "solid",
        borderColor: color.border,
        backgroundColor: color.background,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Top nav: the BrandMark lockup (full app only). */}
      {!slim && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 26px",
            borderBottom: `1px solid ${color.border}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Img src={staticFile("brand/signal-sphere.svg")} style={{ width: 38, height: 38 }} />
            <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em" }}>apo</span>
          </div>
          <span
            style={{
              fontFamily: fontFamilies.mono,
              fontSize: 21,
              color: color.mutedForeground,
              border: `1px solid ${color.border}`,
              padding: "8px 18px",
            }}
          >
            admin@test.com
          </span>
        </div>
      )}

      <div style={{ display: "flex", minHeight: contentHeight }}>
        {/* Sidebar: the real IA — same groups and icons as dashboard-ia.ts. */}
        {!slim && (
          <div
            style={{
              width: 300,
              flexShrink: 0,
              borderRight: `1px solid ${color.borderFaint}`,
              padding: "24px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 30,
            }}
          >
            {NAV.map((group) => (
              <div key={group.group} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={groupLabel}>{group.group}</div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = item.id === activeNav;
                  return (
                    <div
                      key={item.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 14px",
                        background: active ? color.muted : "transparent",
                        color: active ? color.foreground : color.mutedForeground,
                        fontSize: 24,
                      }}
                    >
                      <Icon size={24} strokeWidth={1.75} />
                      <span>{item.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {/* Content: breadcrumb header + the beat's stage. */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              padding: "16px 26px",
              borderBottom: `1px solid ${color.borderFaint}`,
              fontSize: 23,
            }}
          >
            <span style={{ color: color.foreground, fontWeight: 600 }}>acme</span>
            <span style={{ color: color.mutedForeground }}>|</span>
            <span style={{ color: color.mutedForeground }}>{breadcrumb || activeLabel}</span>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 30,
            }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

const groupLabel = {
  fontFamily: fontFamilies.mono,
  fontSize: 18,
  fontWeight: 600,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  color: color.faintForeground,
  padding: "0 14px 6px",
} as const;
