import type { ComponentType } from "react";
import {
  Calendar,
  FlaskConical,
  Layers,
  Waypoints,
} from "lucide-react";

export type DashboardIcon = ComponentType<{
  className?: string;
  suppressHydrationWarning?: boolean;
}>;

export type DashboardIAItem = {
  label: string;
  href: string;
  icon: DashboardIcon;
  description?: string;
};

export type DashboardIAGroup = {
  kind: "primary" | "supporting";
  label: string;
  description?: string;
  icon?: DashboardIcon;
  items: DashboardIAItem[];
};

const dashboardIAGroups: DashboardIAGroup[] = [
  {
    kind: "primary",
    label: "Agent Testing",
    description: "Define task coverage, inspect task behavior, and manage batch runs.",
    icon: FlaskConical,
    items: [
      {
        label: "Tasks",
        href: "/tasks",
        icon: FlaskConical,
        description: "Browse task structure and files",
      },
      {
        label: "Runs",
        href: "/runs",
        icon: Layers,
        description: "Task run history — expand a run to see its task executions",
      },
      {
        label: "Schedules",
        href: "/schedules",
        icon: Calendar,
        description: "Automated recurring task execution",
      },
    ],
  },
  {
    kind: "primary",
    label: "Observability",
    description: "Use one canonical trace home across task runs and other agent execution paths.",
    icon: Waypoints,
    items: [
      {
        label: "Traces",
        href: "/traces",
        icon: Waypoints,
        description: "Canonical trace inspection and debugging",
      },
    ],
  },
];

export const dashboardPrimaryNavGroups = dashboardIAGroups.filter(
  (group) => group.kind === "primary",
);

export const dashboardAllItems = dashboardIAGroups.flatMap(
  (group) => group.items,
);
