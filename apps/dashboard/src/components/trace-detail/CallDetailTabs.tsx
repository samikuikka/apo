"use client";

import { ExpandableJson } from "@/components/ExpandableJson";
import { ChatMessagePreview } from "./ChatMessagePreview";
import { TraceEventPreview } from "./TraceEventPreview";
import { detectTraceEventKind } from "./trace-event-utils";
import { CommentableJsonView } from "./comments/CommentableJsonView";
import type { JsonDataField } from "./comments/selectionToPath";
import { Markdown } from "./Markdown";

/** When provided, the JSON view enables inline text-selection comments. */
export interface CommentAnchor {
  objectId: string;
  objectType: string;
  projectId?: string;
  dataField: JsonDataField;
}

interface CallDetailTabsProps {
  data: any;
  title: string;
  viewMode?: "preview" | "json";
  /** Enable inline comments on the JSON view. Only meaningful for
   * input/output/metadata sections of a commentable object. */
  comment?: CommentAnchor;
  onCommentCreated?: () => void;
}

export function CallDetailTabs({
  data,
  title,
  viewMode = "preview",
  comment,
  onCommentCreated,
}: CallDetailTabsProps) {
  const isChatML = detectChatML(data);
  const traceEventKind = detectTraceEventKind(data);
  const hasTypedEventPreview = traceEventKind !== "unknown";
  const normalized = normalizeData(data);
  const readableText = extractReadableText(normalized);
  const flatEntries = getFlatKeyValueEntries(normalized);

  return (
    <section className="border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      <header className="pb-2">
        <div className="text-[11px] font-medium text-muted-foreground">
          {title}
        </div>
      </header>

      {viewMode === "preview" ? (
        isChatML ? (
          <ChatMessagePreview data={data} />
        ) : hasTypedEventPreview ? (
          <TraceEventPreview data={data} />
        ) : readableText ? (
          <ReadableTextPreview text={readableText} />
        ) : flatEntries ? (
          <FlatKeyValuePreview entries={flatEntries} />
        ) : (
          <ExpandableJson data={data} />
        )
      ) : comment ? (
        <CommentableJsonView
          data={data}
          dataField={comment.dataField}
          objectId={comment.objectId}
          objectType={comment.objectType}
          projectId={comment.projectId}
          onCommentCreated={onCommentCreated}
          bare
        />
      ) : (
        <ExpandableJson data={data} />
      )}
    </section>
  );
}


function FlatKeyValuePreview({
  entries,
}: {
  entries: Array<[string, string | number | boolean | null]>;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/10">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="flex items-start justify-between gap-4 border-b border-border/60 px-3 py-2.5 last:border-b-0"
        >
          <span className="text-[11px] text-muted-foreground">
            {humanizeKey(key)}
          </span>
          <span className="font-mono text-sm text-foreground">{String(value)}</span>
        </div>
      ))}
    </div>
  );
}

function ReadableTextPreview({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/10 px-3 py-2.5">
      <Markdown>{text}</Markdown>
    </div>
  );
}

function isValidContent(content: unknown): boolean {
  if (typeof content === "string") return true;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

function detectChatML(data: any): boolean {
  if (!data || typeof data !== "object") {
    if (typeof data === "string") {
      try {
        const parsed = JSON.parse(data);
        return detectChatML(parsed);
      } catch {
        return false;
      }
    }
    return false;
  }

  if (data.messages && Array.isArray(data.messages)) {
    return data.messages.length > 0 &&
      data.messages.every((msg: any) =>
        msg && typeof msg === "object" &&
        msg.role && isValidContent(msg.content),
      );
  }

  if (data.choices && Array.isArray(data.choices) && data.choices.length > 0) {
    const choice = data.choices[0];
    return choice.message &&
      typeof choice.message === "object" &&
      choice.message.role &&
      isValidContent(choice.message.content);
  }

  return false;
}

function normalizeData(data: any): any {
  if (typeof data !== "string") {
    return data;
  }

  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function getFlatKeyValueEntries(data: any): Array<[string, string | number | boolean | null]> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }

  const entries = Object.entries(data).filter(([, value]) =>
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean",
  ) as Array<[string, string | number | boolean | null]>;

  if (entries.length === 0 || entries.length !== Object.keys(data).length || entries.length > 8) {
    return null;
  }

  return entries;
}

function extractReadableText(data: any): string | null {
  if (typeof data === "string") {
    return data;
  }

  if (!data || typeof data !== "object") {
    return null;
  }

  if (typeof data.text === "string" && data.text.trim()) {
    return data.text;
  }

  if (typeof data.content === "string" && data.content.trim()) {
    return data.content;
  }

  if (typeof data.message === "string" && data.message.trim()) {
    return data.message;
  }

  if (data.output && typeof data.output === "object") {
    return extractReadableText(data.output);
  }

  if (data.data && typeof data.data === "object") {
    return extractReadableText(data.data);
  }

  return null;
}

function humanizeKey(key: string) {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}
