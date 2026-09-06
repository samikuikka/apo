import type { CSSProperties } from "react";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useAppear } from "../lib/beat";

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  /** Frame the message appears at. */
  at: number;
};

/**
 * A conversation transcript panel. The point of this component is to be the
 * thing that *sounds* right — fluent, helpful, confident — regardless of
 * what the agent actually produced.
 */
export const ChatPanel = ({
  messages,
  width = 620,
  title = "conversation",
}: {
  messages: ChatMessage[];
  width?: number;
  title?: string;
}) => (
  <div
    style={{
      width,
      backgroundColor: color.card,
      borderWidth: 1,
      borderStyle: "solid",
      borderColor: color.border,
    }}
  >
    <div
      style={{
        padding: "12px 20px",
        borderBottom: `1px solid ${color.borderFaint}`,
        fontFamily: fontFamilies.mono,
        fontSize: 19,
        letterSpacing: "0.18em",
        color: color.mutedForeground,
      }}
    >
      {title.toUpperCase()}
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 20, padding: 24 }}>
      {messages.map((message, index) => (
        <ChatBubble key={index} message={message} />
      ))}
    </div>
  </div>
);

const ChatBubble = ({ message }: { message: ChatMessage }) => {
  const appear = useAppear(message.at);
  const isUser = message.role === "user";
  const style: CSSProperties = {
    ...appear,
    alignSelf: isUser ? "flex-end" : "flex-start",
    maxWidth: "88%",
    padding: "14px 18px",
    backgroundColor: isUser ? color.muted : "transparent",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: isUser ? "transparent" : color.borderFaint,
    fontSize: 25,
    lineHeight: 1.45,
    color: color.foreground,
  };
  return <div style={style}>{message.text}</div>;
};
