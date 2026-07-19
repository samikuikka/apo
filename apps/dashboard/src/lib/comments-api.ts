import { apiClient } from "./api-client";

export interface CommentReaction {
  emoji: string;
  user_ids: string[];
}

export interface Comment {
  id: string;
  project_id: string;
  object_id: string;
  object_type: string;
  content: string;
  author_id: string | null;
  author_name: string | null;
  parent_comment_id: string | null;
  mentioned_user_ids: string[] | null;
  reactions: CommentReaction[];
  /** Inline-comment anchor: which JSON field the selection is in
   * ("input" | "output" | "metadata"). Null for whole-object comments. */
  selection_field?: string | null;
  /** Parallel array of JSON-path strings (one per row spanned). */
  selection_path?: string[] | null;
  /** Parallel array of char offsets marking the selection start per row. */
  selection_range_start?: number[] | null;
  /** Parallel array of char offsets marking the selection end per row. */
  selection_range_end?: number[] | null;
  /** The literal selected text, for re-rendering highlights. */
  selected_text?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateCommentRequest {
  object_id: string;
  object_type: string;
  content: string;
  project_id?: string;
  author_id?: string;
  author_name?: string;
  parent_comment_id?: string;
  mentioned_user_ids?: string[];
  /** Inline-comment selection anchor. Omit for whole-object comments. */
  selection_field?: string;
  selection_path?: string[];
  selection_range_start?: number[];
  selection_range_end?: number[];
  selected_text?: string;
}

const NO_CACHE = { cache: "no-store" } as const;

// listComments / getCommentCounts degrade gracefully (return empty) on error
// so a missing/forbidden comment thread never breaks the surrounding UI.

export async function listComments(
  objectId: string,
  objectType: string,
): Promise<Comment[]> {
  try {
    return await apiClient<Comment[]>("/api/v1/comments", {
      ...NO_CACHE,
      query: { object_id: objectId, object_type: objectType },
    });
  } catch {
    return [];
  }
}

export const createComment = (
  request: CreateCommentRequest,
): Promise<Comment> =>
  apiClient("/api/v1/comments", { method: "POST", body: request });

export const deleteComment = (commentId: string): Promise<void> =>
  apiClient(`/api/v1/comments/${commentId}`, { method: "DELETE" });

export const toggleReaction = (
  commentId: string,
  emoji: string,
  userId: string,
): Promise<Comment> =>
  apiClient(`/api/v1/comments/${commentId}/reactions`, {
    method: "POST",
    body: { emoji, user_id: userId },
  });

export async function getCommentCounts(
  objectIds: string[],
  objectType: string,
): Promise<Record<string, number>> {
  if (objectIds.length === 0) return {};
  try {
    return await apiClient<Record<string, number>>("/api/v1/comments/counts", {
      ...NO_CACHE,
      query: { object_ids: objectIds.join(","), object_type: objectType },
    });
  } catch {
    return {};
  }
}
