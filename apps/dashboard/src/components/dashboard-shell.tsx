"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { ProjectSwitcher } from "@/components/project-switcher";
import {
  dashboardAllItems,
  dashboardPrimaryNavGroups,
} from "@/lib/dashboard-ia";
import { hrefWithRunCohort } from "@/lib/run-cohort";
import {
  RunCohortProvider,
  useRunCohort,
} from "@/lib/run-cohort-context";

export function DashboardShell({
  children,
  projectId,
}: {
  children: React.ReactNode;
  projectId: string;
}) {
  // The provider wraps both the nav and the page, so the page can publish the
  // cohort it is showing and the nav can hand it to the next page.
  return (
    <RunCohortProvider>
      <DashboardChrome projectId={projectId}>{children}</DashboardChrome>
    </RunCohortProvider>
  );
}

function DashboardChrome({
  children,
  projectId,
}: {
  children: React.ReactNode;
  projectId: string;
}) {
  const pathname = usePathname();
  const runCohort = useRunCohort();
  const { status } = useSession();
  const anonymous = status === "unauthenticated";
  const p = (path: string) => `/project/${projectId}${path}`;
  const activeNav =
    dashboardAllItems.find((item) => pathname.startsWith(p(item.href))) ??
    dashboardAllItems[0];

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "16rem",
          top: "3.5rem",
          height: "calc(100svh - 3.5rem)",
        } as any
      }
    >
      <Sidebar variant="inset" collapsible="icon" className="top-14 h-[calc(100svh-3.5rem)]">
        <SidebarContent>
          {dashboardPrimaryNavGroups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const base = p(item.href);
                    const isActive = pathname.startsWith(base);
                    // Carry the cohort the current page is showing, so leaving
                    // Tasks narrowed to one model lands on the matching runs
                    // rather than the unfiltered list.
                    const href = item.carriesRunCohort
                      ? hrefWithRunCohort(base, runCohort)
                      : base;
                    return (
                      <SidebarMenuItem key={base}>
                        <SidebarMenuButton asChild isActive={isActive}>
                          <Link href={href}>
                            <Icon className="size-4" suppressHydrationWarning />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <div className="flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden bg-background text-foreground">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-4 md:px-6">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mr-1 h-5!" />
            <nav
              aria-label="Breadcrumb"
              className="flex min-w-0 items-center gap-1 text-sm"
            >
              {anonymous ? (
                // The switcher is session chrome; anonymous demo visitors
                // get a plain label instead.
                <span className="truncate text-sm font-medium">Demo workspace</span>
              ) : (
                <ProjectSwitcher currentProjectId={projectId} />
              )}
              <Separator orientation="vertical" className="mx-1 h-5!" />
              <span className="truncate font-medium text-muted-foreground">
                {activeNav?.label}
              </span>
            </nav>
          </header>
          <main className="flex-1 overflow-y-auto">{children}</main>
          <Toaster />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
