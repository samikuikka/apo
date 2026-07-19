"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { ArrowLeft } from "lucide-react";
import {
  INSTANCE_ITEMS,
  PERSONAL_ITEMS,
  PROJECT_ITEMS,
  settingsHref,
  type SettingsNavItem,
} from "@/app/settings/nav-config";

export function SettingsSidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.is_admin === true;

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-background">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Dashboard
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Settings
        </p>

        <SidebarGroup label="Personal" items={PERSONAL_ITEMS} pathname={pathname} />

        <div className="mt-6">
          <SidebarGroup label="Project" items={PROJECT_ITEMS} pathname={pathname} />
        </div>

        {isAdmin && (
          <div className="mt-6">
            <SidebarGroup
              label="Instance (dev)"
              items={INSTANCE_ITEMS}
              pathname={pathname}
            />
          </div>
        )}
      </nav>
    </aside>
  );
}

function SidebarGroup({
  label,
  items,
  pathname,
  badge,
}: {
  label: string;
  items: SettingsNavItem[];
  pathname: string;
  badge?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 px-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          {label}
        </p>
        {badge}
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const href = settingsHref(item);
          const isActive = pathname === href || pathname.startsWith(href + "/");
          const Icon = item.icon;
          return (
            <li key={href}>
              <Link
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                  isActive
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
