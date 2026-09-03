"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { BrandMark } from "@/components/brand/brand-mark";
import { DemoBadge } from "@/components/demo-badge";
import { UserMenu } from "@/components/user-menu";

// Routes that suppress the main TopNav. Auth flows render their own header
// (they predate the session) — showing both would duplicate the brand mark.
const NAV_HIDDEN_ROUTES = [
  "/login",
  "/setup",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  "/join",
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

  const inDemo = pathname === "/project/demo" || pathname.startsWith("/project/demo/");

  return (
    <nav className="sticky top-0 z-[50] flex h-12 w-full items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
      <div className="flex items-center gap-4">
        <BrandMark />
        {inDemo && status !== "authenticated" ? <DemoBadge /> : null}
      </div>
      <div className="flex items-center gap-4">
        {status === "authenticated" ? (
          <UserMenu />
        ) : (
          // Anonymous demo visitors get the one honest CTA.
          <Link
            href="/login"
            data-testid="anon-sign-in"
            className="inline-flex h-8 items-center border border-border px-3 text-xs font-medium hover:bg-accent"
          >
            Sign in
          </Link>
        )}
      </div>
    </nav>
  );
}
