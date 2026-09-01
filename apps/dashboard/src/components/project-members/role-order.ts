import type { ProjectRole } from "@/lib/projects-api";

/** Owners first, then admins, then members, then viewers — default order. */
export const ROLE_RANK: Record<ProjectRole, number> = { owner: 0, admin: 1, member: 2, viewer: 3 }
