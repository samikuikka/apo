"use client";

import { MessageSquare } from "lucide-react";

interface CommentCountIconProps {
  count: number;
}

export function CommentCountIcon({ count }: CommentCountIconProps) {
  if (count <= 0) return null;

  return (
    <span
      className="inline-flex items-center gap-0.5 text-primary/70"
      title={`${count} comment${count !== 1 ? "s" : ""}`}
    >
      <MessageSquare className="h-3 w-3" />
      {count > 1 && (
        <span className="text-[10px] font-medium">{count}</span>
      )}
    </span>
  );
}
