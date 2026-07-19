"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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

export function DashboardShell({
  children,
  projectId,
}: {
  children: React.ReactNode;
  projectId: string;
}) {
  const pathname = usePathname();
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
                    const href = p(item.href);
                    const isActive = pathname.startsWith(href);
                    return (
                      <SidebarMenuItem key={href}>
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
              <ProjectSwitcher currentProjectId={projectId} />
              <Separator orientation="vertical" className="mx-1 h-5!" />
              <span className="truncate font-medium text-muted-foreground">
                {activeNav?.label}
              </span>
            </nav>
          </header>
          <div className="flex-1 overflow-y-auto">{children}</div>
          <Toaster />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
