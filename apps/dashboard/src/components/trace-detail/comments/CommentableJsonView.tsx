"use client";

import { useRef, type ReactNode } from "react";
import { ExpandableJson } from "@/components/ExpandableJson";
import {
  InlineCommentSelectionProvider,
  useTextSelection,
  useInlineCommentSelection,
} from "./useTextSelection";
import type { JsonDataField } from "./selectionToPath";
import { InlineCommentBubble } from "./InlineCommentBubble";
import { cn } from "@/lib/utils";

interface CommentableJsonViewProps {
  data: unknown;
  dataField: JsonDataField;
  /** Object this JSON belongs to (observation id, trace id, …). */
  objectId: string;
  objectType: string;
  projectId?: string;
  enabled?: boolean;
  label?: string;
  className?: string;
  /** Called after an inline comment is created so parents can refresh. */
  onCommentCreated?: () => void;
  /** Hide the raw JSON viewer chrome (e.g. when embedded in a tab). */
  bare?: boolean;
  /** Optional extra content rendered above the viewer. */
  children?: ReactNode;
}

/**
 * Wraps ExpandableJson so users can select text within input/output/metadata
 * and post an inline comment anchored to that selection.
 */
export function CommentableJsonView(props: CommentableJsonViewProps) {
  // Provider must wrap the subtree that consumes the selection context.
  return (
    <InlineCommentSelectionProvider>
      <CommentableJsonViewInner {...props} />
    </InlineCommentSelectionProvider>
  );
}

function CommentableJsonViewInner({
  data,
  dataField,
  objectId,
  objectType,
  projectId,
  enabled = true,
  label,
  className,
  onCommentCreated,
  bare,
}: CommentableJsonViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTextSelection({ containerRef, dataField, enabled });
  const { pending } = useInlineCommentSelection();

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <ExpandableJson
        data={data}
        label={label}
        className={bare ? "!rounded-none !border-0 !shadow-none" : undefined}
      />
      {enabled && pending && (
        <InlineCommentBubble
          pending={pending}
          objectId={objectId}
          objectType={objectType}
          projectId={projectId}
          onSubmitted={() => onCommentCreated?.()}
        />
      )}
    </div>
  );
}
