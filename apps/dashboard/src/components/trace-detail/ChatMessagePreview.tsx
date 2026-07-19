"use client";

import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { Sparkles, User, Wrench, Cpu } from "lucide-react";
import { useMemo, useRef, useCallback } from "react";
import { ToolDefinitionsSection } from "./ToolDefinitionsSection";
import { extractTools, countToolInvocations } from "./tool-utils";
import { ThinkingBlock } from "./ThinkingBlock";
import { extractThinkingContent } from "./thinking-utils";
import { CollapsibleHistory } from "./CollapsibleHistory";
import { Markdown } from "./Markdown";

interface ChatMessage {
  role: string;
  content: string | ContentPart[];
  tool_calls?: Array<{
    function?: {
      name: string;
      arguments: string;
    };
  }>;
  name?: string;
  thinking?: string;
  reasoning_content?: string;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url?: { url: string } }
  | { type: "input_audio"; input_audio?: { url: string } }
  | { type: string; [key: string]: unknown };

interface ChatMessagePreviewProps {
  data: unknown;
}

export function ChatMessagePreview({ data }: ChatMessagePreviewProps) {
  const messages = useMemo(() => parseMessages(data), [data]);
  const tools = useMemo(() => extractTools(data), [data]);
  const invocationCounts = useMemo(
    () => countToolInvocations(messages),
    [messages],
  );
  const toolCallCounter = useRef(0);

  const getNextToolCallNumber = useCallback(() => {
    toolCallCounter.current += 1;
    return toolCallCounter.current;
  }, []);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center border border-dashed border-border/60 bg-muted/30 p-8">
        <p className="text-sm text-muted-foreground">No messages to display</p>
      </div>
    );
  }

  const firstThree = messages.slice(0, 3);
  const lastThree = messages.length > 6 ? messages.slice(-3) : [];
  const middleMessages = messages.length > 6 ? messages.slice(3, -3) : [];

  const renderMessage = (msg: ChatMessage, idx: number) => (
    <MessageBubble
      key={msg.role === "user" ? `user-${idx}` : `msg-${idx}`}
      message={msg}
      getNextToolCallNumber={getNextToolCallNumber}
    />
  );

  return (
    <div className="space-y-3">
      {tools.length > 0 && (
        <ToolDefinitionsSection
          tools={tools}
          invocationCounts={invocationCounts}
        />
      )}
      <CollapsibleHistory
        totalMessages={messages.length}
        visibleStart={firstThree.map(renderMessage)}
        hiddenMiddle={middleMessages.map((msg, i) => renderMessage(msg, i + 3))}
        visibleEnd={lastThree.map((msg, i) =>
          renderMessage(msg, messages.length - lastThree.length + i),
        )}
      />
    </div>
  );
}

function MessageBubble({
  message,
  getNextToolCallNumber,
}: {
  message: ChatMessage;
  getNextToolCallNumber: () => number;
}) {
  const roleInfo = getRoleInfo(message.role);
  const thinkingContent = extractThinkingContent(message);
  const contentParts = parseContentParts(message.content);

  return (
    <div className={`flex gap-3 ${message.role === "user" ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center border ${
          roleInfo.bgColor
        }`}
      >
        {roleInfo.icon}
      </div>

      <div className={`flex-1 space-y-2 ${message.role === "user" ? "items-end" : "items-start"} flex flex-col`}>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-xs ${roleInfo.textColor}`}>
            {roleInfo.label}
            {message.name && <span className="ml-1 opacity-70">({message.name})</span>}
          </Badge>
        </div>

        {hasContent(message.content) && (
          <div
            className={`border px-4 py-3 text-sm ${
              message.role === "user"
                ? "bg-primary/10 border-primary/20"
                : "bg-muted/40 border-border/60"
            }`}
          >
            <MessageContent parts={contentParts} />
          </div>
        )}
        {!hasContent(message.content) && !message.tool_calls?.length && (
          <div className="border border-dashed border-border/60 px-4 py-3 text-sm">
            <span className="italic text-muted-foreground">Empty message</span>
          </div>
        )}

        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className="space-y-2">
            {message.tool_calls.map((call) => {
              const callNumber = getNextToolCallNumber();
              return (
                <div
                  key={`tc-${call.function?.name ?? callNumber}`}
                  className="border border-warning bg-warning/10 px-3 py-2"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <Wrench className="h-3.5 w-3.5 text-warning" />
                    <span className="text-xs font-mono font-medium text-warning">
                      Tool Call #{callNumber}
                    </span>
                    <span className="text-xs font-mono text-warning">
                      {call.function?.name || "unknown"}
                    </span>
                  </div>
                  {call.function?.arguments && (
                    <pre className="mt-1 overflow-x-auto text-[11px] font-mono text-muted-foreground">
                      {call.function.arguments}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {thinkingContent && <ThinkingBlock thinking={thinkingContent} />}
      </div>
    </div>
  );
}

function MessageContent({ parts }: { parts: ContentPart[] }) {
  return (
    <div className="max-w-none space-y-2 text-sm text-foreground">
      {parts.map((part) => {
        if (part.type === "image_url") {
          const url = (part as { type: "image_url"; image_url?: { url: string } }).image_url?.url ?? "";
          return <ImageReference key={`img-${url}`} url={url} />;
        }
        if (part.type === "input_audio") {
          const url = (part as { type: "input_audio"; input_audio?: { url: string } }).input_audio?.url ?? "";
          return <AudioReference key={`audio-${url}`} url={url} />;
        }
        if (part.type === "text") {
          const text = (part as { type: "text"; text: string }).text;
          return <Markdown key={`text-${text}`}>{text}</Markdown>;
        }
        return null;
      })}
    </div>
  );
}

function ImageReference({ url }: { url: string }) {
  if (!url || url.startsWith("/")) {
    return (
      <span className="inline-flex items-center gap-1.5 border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="text-xs">[Image]</span>
        {url && <span className="font-mono">{url}</span>}
      </span>
    );
  }

  return (
    <div className="my-1">
      <Image
        src={url}
        alt="Content"
        unoptimized
        className="max-h-64 max-w-full border border-border/60 object-contain"
        onError={(e) => {
          const target = e.currentTarget;
          target.style.display = "none";
          const placeholder = document.createElement("span");
          placeholder.className = "inline-flex items-center gap-1.5 border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground";
          placeholder.textContent = "[Image: failed to load]";
          target.parentNode?.appendChild(placeholder);
        }}
      />
    </div>
  );
}

function AudioReference({ url }: { url: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-border/60 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
      <span className="text-xs">[Audio]</span>
      {url && <span className="font-mono">{url}</span>}
    </span>
  );
}

function parseContentParts(content: string | ContentPart[]): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

function hasContent(content: string | ContentPart[]): boolean {
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

function parseMessages(data: unknown): ChatMessage[] {
  if (!data) return [];

  let obj = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data);
    } catch {
      return [];
    }
  }

  if (obj && typeof obj === "object" && "messages" in obj && Array.isArray((obj as Record<string, unknown>).messages)) {
    return (obj as { messages: ChatMessage[] }).messages;
  }

  if (
    obj &&
    typeof obj === "object" &&
    "choices" in obj &&
    Array.isArray((obj as Record<string, unknown>).choices) &&
    ((obj as { choices: unknown[] }).choices.length as number) > 0
  ) {
    const choice = (obj as { choices: Array<{ message?: ChatMessage }> }).choices[0];
    if (choice.message && typeof choice.message === "object") {
      return [choice.message];
    }
  }

  return [];
}

function getRoleInfo(role: string) {
  const roleMap: Record<
    string,
    { label: string; icon: React.ReactNode; bgColor: string; textColor: string }
  > = {
    system: {
      label: "System",
      icon: <Cpu className="h-4 w-4 text-violet-600" />,
      bgColor: "bg-violet-900/30 border-violet-700",
      textColor: "text-violet-300",
    },
    user: {
      label: "User",
      icon: <User className="h-4 w-4 text-blue-600" />,
      bgColor: "bg-blue-900/30 border-blue-700",
      textColor: "text-blue-300",
    },
    assistant: {
      label: "Assistant",
      icon: <Sparkles className="h-4 w-4 text-emerald-600" />,
      bgColor: "bg-emerald-900/30 border-emerald-700",
      textColor: "text-emerald-300",
    },
    tool: {
      label: "Tool",
      icon: <Wrench className="h-4 w-4 text-warning" />,
      bgColor: "bg-warning/10 border-warning",
      textColor: "text-warning",
    },
  };

  return (
    roleMap[role] || {
      label: role.charAt(0).toUpperCase() + role.slice(1),
      icon: <span className="text-xs">{role[0]}</span>,
      bgColor: "bg-muted",
      textColor: "text-foreground",
    }
  );
}
