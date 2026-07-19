"use client";

import { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type Comment, deleteComment, toggleReaction } from "@/lib/comments-api";
import { ReactionBar } from "./ReactionBar";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

const COLLAPSE_THRESHOLD = 200;
const CURRENT_USER_ID = "current-user";

interface CommentListProps {
  comments: Comment[];
  onCommentDeleted: () => void;
  onReactionToggled: () => void;
}

export function CommentList({
  comments,
  onCommentDeleted,
  onReactionToggled,
}: CommentListProps) {
  if (comments.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground/50">No comments yet</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {comments.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          onDeleted={onCommentDeleted}
          onReactionToggled={onReactionToggled}
        />
      ))}
    </div>
  );
}

function CommentItem({
  comment,
  onDeleted,
  onReactionToggled,
}: {
  comment: Comment;
  onDeleted: () => void;
  onReactionToggled: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isLong = comment.content.length > COLLAPSE_THRESHOLD;

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteComment(comment.id);
      onDeleted();
    } catch (err) {
      console.error("Failed to delete comment:", err);
      setConfirmDelete(false);
    }
  }, [comment.id, confirmDelete, onDeleted]);

  const handleReaction = useCallback(
    async (emoji: string) => {
      try {
        await toggleReaction(comment.id, emoji, CURRENT_USER_ID);
        onReactionToggled();
      } catch (err) {
        console.error("Failed to toggle reaction:", err);
      }
    },
    [comment.id, onReactionToggled],
  );

  const displayContent =
    isLong && !expanded
      ? comment.content.slice(0, COLLAPSE_THRESHOLD) + "..."
      : comment.content;

  const timeStr = comment.created_at
    ? new Date(comment.created_at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      })
    : "";

  return (
    <div className="group rounded-md border border-border/30 bg-muted/20 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-medium text-primary">
            {(comment.author_name || "U").charAt(0).toUpperCase()}
          </div>
          <span className="text-xs font-medium text-foreground">
            {comment.author_name || "Unknown"}
          </span>
          <span className="text-[10px] text-muted-foreground/60">
            {timeStr}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={handleDelete}
          onBlur={() => setConfirmDelete(false)}
          className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          aria-label={confirmDelete ? "Confirm delete" : "Delete comment"}
        >
          <Trash2 className={`h-3 w-3 ${confirmDelete ? "text-destructive" : "text-muted-foreground"}`} />
          {confirmDelete && (
            <span className="text-destructive text-[10px]">Confirm</span>
          )}
        </Button>
      </div>

      <div className="mt-1.5 text-sm text-foreground/80 prose prose-xs prose-p:m-0 prose-pre:m-0 prose-pre:bg-muted/50 prose-code:text-xs max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {comment.selected_text && (
          <blockquote className="mb-1.5 border-l-2 border-primary/40 pl-2 text-[11px] italic text-muted-foreground not-prose">
            <span className="mr-1 rounded-sm bg-primary/10 px-1 text-[9px] font-medium uppercase not-italic text-primary">
              {comment.selection_field}
            </span>
            “{comment.selected_text.length > 160
              ? `${comment.selected_text.slice(0, 160)}…`
              : comment.selected_text}”
          </blockquote>
        )}
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {displayContent}
        </ReactMarkdown>
      </div>

      {isLong && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-primary/70 hover:text-primary"
        >
          Show more
        </button>
      )}

      <div className="mt-2">
        <ReactionBar
          reactions={comment.reactions}
          currentUserId={CURRENT_USER_ID}
          onToggle={handleReaction}
        />
      </div>
    </div>
  );
}
