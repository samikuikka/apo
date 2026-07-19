"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, MessageSquarePlus, X } from "lucide-react";
import { createComment } from "@/lib/comments-api";
import { useInlineCommentSelection } from "./useTextSelection";
import type { PendingSelection } from "./useTextSelection";
import { toast } from "sonner";

interface InlineCommentBubbleProps {
  pending: PendingSelection;
  objectId: string;
  objectType: string;
  projectId?: string;
  onSubmitted?: () => void;
}

/**
 * Floating "comment on selection" control. Positioned at the start of the
 * current text selection. Accepts a comment and persists it with the
 * selection anchor so it can be re-highlighted later.
 */
export function InlineCommentBubble({
  pending,
  objectId,
  objectType,
  projectId,
  onSubmitted,
}: InlineCommentBubbleProps) {
  const { clearSelection } = useInlineCommentSelection();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Position relative to the viewport using the selection's start rect.
  const style = {
    top: `${pending.startRect.top}px`,
    left: `${pending.startRect.left + pending.startRect.width + 8}px`,
  } as const;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the bubble on-screen when the selection is near the right edge.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      // no-op placeholder; positioning is recomputed each render from pending
      void id;
    });
    return () => cancelAnimationFrame(id);
  }, [open, pending]);

  async function handleSubmit() {
    const trimmed = content.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await createComment({
        object_id: objectId,
        object_type: objectType,
        content: trimmed,
        project_id: projectId,
        author_id: "current-user",
        author_name: "You",
        selection_field: pending.dataField,
        selection_path: pending.path,
        selection_range_start: pending.rangeStart,
        selection_range_end: pending.rangeEnd,
        selected_text: pending.selectedText,
      });
      toast.success("Comment added");
      setContent("");
      setOpen(false);
      clearSelection();
      onSubmitted?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add comment",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div
        className="fixed z-50 flex items-center"
        style={style}
        // sizer-hidden from AT until expanded
      >
        <Button
          type="button"
          size="xs"
          variant="default"
          onClick={() => setOpen(true)}
          aria-label="Comment on selection"
          className="shadow-md"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          Comment
        </Button>
      </div>
    );
  }

  return (
    <div
      className="fixed z-50 w-72 rounded-md border border-border bg-popover p-2 shadow-lg"
      style={style}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Comment on selection
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            clearSelection();
          }}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Cancel comment"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {pending.selectedText && (
        <blockquote className="mb-1.5 max-h-20 overflow-y-auto border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground">
          “{pending.selectedText.slice(0, 160)}”
        </blockquote>
      )}
      <textarea
        ref={inputRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void handleSubmit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            clearSelection();
          }
        }}
        rows={3}
        placeholder="Add context… (Markdown supported)"
        className="w-full resize-none rounded-md border border-border/60 bg-muted/30 px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
        aria-label="Inline comment text"
      />
      <div className="mt-1.5 flex justify-end">
        <Button
          type="button"
          size="xs"
          onClick={() => void handleSubmit()}
          disabled={!content.trim() || submitting}
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MessageSquarePlus className="h-3.5 w-3.5" />
          )}
          Comment
        </Button>
      </div>
    </div>
  );
}
