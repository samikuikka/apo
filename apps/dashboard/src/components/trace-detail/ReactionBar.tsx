"use client";

import { type CommentReaction } from "@/lib/comments-api";

const QUICK_EMOJIS = ["👍", "❤️", "🎉", "🤔", "👀", "🔥"];

interface ReactionBarProps {
  reactions: CommentReaction[];
  currentUserId: string;
  onToggle: (emoji: string) => void;
}

export function ReactionBar({
  reactions,
  currentUserId,
  onToggle,
}: ReactionBarProps) {
  const hasReactions = reactions.length > 0;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {reactions.map((r) => {
        const isMine = r.user_ids.includes(currentUserId);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            className={`inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${
              isMine
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border/50 bg-muted/30 text-muted-foreground hover:bg-muted/60"
            }`}
            aria-label={`${r.user_ids.length} ${r.emoji} reaction${r.user_ids.length !== 1 ? "s" : ""}`}
          >
            <span>{r.emoji}</span>
            {r.user_ids.length > 1 && (
              <span className="text-[10px]">{r.user_ids.length}</span>
            )}
          </button>
        );
      })}
      {hasReactions && (
        <span className="mx-0.5 text-border">|</span>
      )}
      <div className="flex items-center gap-0.5">
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => onToggle(emoji)}
            className="rounded p-0.5 text-sm opacity-50 hover:opacity-100 transition-opacity"
            aria-label={`Add ${emoji} reaction`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
