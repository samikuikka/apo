"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { signOut } from "next-auth/react";

import { Button } from "@/components/ui/button";
import { StatusPage } from "@/components/status-page";

interface ProjectAccessDeniedProps {
  /** Project identifier from the route, shown as a reference. */
  projectId: string;
  /**
   * Optional project name. The backend 403 response does not currently carry
   * the name, so this is reserved for a future enrichment — when populated it
   * personalizes the headline (e.g. "You don't have access to 'Prompts'").
   */
  projectName?: string;
}

/**
 * Full-page "no access" state for a project the signed-in user is not a member
 * of. Implements the collaboration-first pattern (Notion / Figma / Vercel):
 *
 * - Reveals existence (403, not 404) since callers are authenticated team members.
 * - Explains the two common causes (wrong account vs. needs to be added).
 * - Offers a recovery loop: return to a project you can see, or switch accounts.
 *
 * Rendered centrally by the project layout so every project sub-route inherits
 * the behavior instead of each page re-deriving it from error strings.
 */
export function ProjectAccessDenied({
  projectId,
  projectName,
}: ProjectAccessDeniedProps) {
  const heading = projectName
    ? `You don't have access to "${projectName}"`
    : "You don't have access to this project";

  return (
    <StatusPage
      badge="Access required"
      icon={<Lock className="size-8 text-primary" />}
      title={heading}
      description={
        <>
          This project is private to its team. You may be signed in with the
          wrong account, or a project admin needs to add you as a member.
        </>
      }
    >
      <div className="rounded-none border border-border/60 bg-background/80 px-3 py-2 font-mono text-xs text-muted-foreground">
        Project: {projectId}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" asChild>
          <Link href="/">Back to dashboard</Link>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => signOut({ redirectTo: "/login" })}
        >
          Sign in with a different account
        </Button>
      </div>
    </StatusPage>
  );
}
