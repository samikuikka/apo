"use client";

import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Send } from "lucide-react";

interface CommentInputProps {
  onSubmit: (content: string) => Promise<void>;
  placeholder?: string;
}

export function CommentInput({
  onSubmit,
  placeholder = "Add a comment... (Markdown supported)",
}: CommentInputProps) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    try {
      await onSubmit(trimmed);
      setContent("");
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    } finally {
      setSubmitting(false);
    }
  }, [content, submitting, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    }
  }, []);

  const canSubmit = content.trim().length > 0 && !submitting;

  return (
    <div className="flex items-end gap-2 border-t border-border/50 bg-background p-2">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        placeholder={placeholder}
        rows={1}
        className="min-h-[32px] max-h-[120px] flex-1 resize-none rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        aria-label="Comment text"
      />
      <Button
        type="button"
        size="xs"
        variant={canSubmit ? "default" : "outline"}
        onClick={handleSubmit}
        disabled={!canSubmit}
        aria-label="Submit comment"
      >
        <Send className="h-3 w-3" />
      </Button>
    </div>
  );
}
