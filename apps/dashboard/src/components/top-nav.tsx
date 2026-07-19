"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { BrandMark } from "@/components/brand/brand-mark";
import { UserMenu } from "@/components/user-menu";

// Routes that suppress the main TopNav. Auth flows render their own header
// (they predate the session), and /public pages render a dedicated
// PublicTraceHeader instead — showing both would duplicate the brand mark.
const NAV_HIDDEN_ROUTES = [
  "/login",
  "/setup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  "/public",
];

function isNavHiddenRoute(pathname: string): boolean {
  return NAV_HIDDEN_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

export function TopNav() {
  const pathname = usePathname();
  const { status } = useSession();

  if (isNavHiddenRoute(pathname)) return null;

  return (
    <nav className="sticky top-0 z-[50] flex h-12 w-full items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
      <BrandMark />
      <div className="flex items-center gap-4">
        {status === "authenticated" && <UserMenu />}
      </div>
    </nav>
  );
}
