"use client";

import { useState, useCallback, useEffect } from "react";
import {
  type Comment,
  listComments,
  createComment,
} from "@/lib/comments-api";
import { CommentList } from "./CommentList";
import { CommentInput } from "./CommentInput";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";

interface CommentDrawerProps {
  objectId: string;
  objectType: string;
  projectId?: string;
  /** Increment to force a re-fetch (e.g. after an inline comment is created). */
  refreshNonce?: number;
}

export function CommentDrawer({
  objectId,
  objectType,
  projectId,
  refreshNonce,
}: CommentDrawerProps) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listComments(objectId, objectType);
      setComments(result);
    } finally {
      setLoading(false);
    }
  }, [objectId, objectType]);

  useEffect(() => {
    if (open) {
      fetchComments();
    }
  }, [open, fetchComments, refreshNonce]);

  const handleSubmit = useCallback(
    async (content: string) => {
      await createComment({
        object_id: objectId,
        object_type: objectType,
        content,
        project_id: projectId,
        author_id: "current-user",
        author_name: "You",
      });
      fetchComments();
    },
    [objectId, objectType, projectId, fetchComments],
  );

  const commentCount = comments.length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`Comments (${commentCount})`}
        >
          <MessageSquare className="h-3 w-3" />
          Comments
          {commentCount > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
              {commentCount}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[380px] p-0 flex flex-col">
        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-sm">
            Comments
            {commentCount > 0 && (
              <span className="ml-1.5 text-muted-foreground">
                ({commentCount})
              </span>
            )}
          </SheetTitle>
        </SheetHeader>
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : (
          <CommentList
            comments={comments}
            onCommentDeleted={fetchComments}
            onReactionToggled={fetchComments}
          />
        )}
        <CommentInput onSubmit={handleSubmit} />
      </SheetContent>
    </Sheet>
  );
}
