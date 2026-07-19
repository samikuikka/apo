"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-2 mt-0 last:mb-0 leading-relaxed">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-2 mt-0 list-disc pl-5 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 mt-0 list-decimal pl-5 space-y-0.5">{children}</ol>
  ),
  li: ({ children }) => <li className="mt-0">{children}</li>,
  code: ({ className, children, ...props }) => {
    const match = /language-(\w+)/.exec(className || "");
    return match ? (
      <code className={className} {...props}>
        {children}
      </code>
    ) : (
      <code
        className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-2 mt-0 bg-muted p-3 text-xs font-mono overflow-x-auto">
      {children}
    </pre>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => (
    <em className="italic text-foreground/90">{children}</em>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2 hover:text-primary/80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-muted-foreground/30 pl-3 italic text-muted-foreground my-2">
      {children}
    </blockquote>
  ),
  h1: ({ children }) => (
    <h1 className="text-lg font-bold mb-2 mt-3">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-bold mb-2 mt-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-bold mb-1 mt-2">{children}</h3>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border/60 bg-muted/40 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border/60 px-2 py-1">{children}</td>
  ),
  hr: () => <hr className="border-border/60 my-3" />,
};

interface MarkdownProps {
  children: string;
  className?: string;
}

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn("max-w-none text-sm text-foreground", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
