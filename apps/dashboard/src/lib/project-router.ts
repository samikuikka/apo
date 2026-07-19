"use client";

import { useParams } from "next/navigation";

export const DEFAULT_PROJECT = "example-service";
export const DEMO_PROJECT = "demo";

/** Get the current project ID from the URL params (client-side). */
export function useProjectId(): string {
  const params = useParams<{ projectId?: string }>();
  return params?.projectId ?? DEFAULT_PROJECT;
}

/** Check if the current project is the demo workspace. */
export function useIsDemo(): boolean {
  return useProjectId() === DEMO_PROJECT;
}
