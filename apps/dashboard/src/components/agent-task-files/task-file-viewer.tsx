"use client";

import { useState, useMemo } from "react";
import { Copy, Download, FileText } from "lucide-react";
import type { TaskFileContentResponse } from "@/lib/agent-task-api";
import { highlightLine } from "./syntax-highlight";

interface TaskFileViewerProps {
  file: TaskFileContentResponse | null;
  error?: string | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CodeBlock({ content, language }: { content: string; language: string }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const lastLineEmpty = content.endsWith("\n") && lines.length > 0;
  const displayLines = lastLineEmpty ? lines.slice(0, -1) : lines;

  return (
    <div className="overflow-auto flex-1">
      <pre className="text-xs font-mono leading-6">
        <code>
          {displayLines.map((line, i) => (
            <div key={`line-${i + 1}`} className="grid grid-cols-[48px_1fr] items-start px-3 hover:bg-muted/10">
              <span className="select-none text-right text-[11px] text-muted-foreground/60 pr-4">
                {i + 1}
              </span>
              <span className="whitespace-pre-wrap break-words text-foreground">
                {highlightLine(line, language)}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

export function TaskFileViewer({ file, error }: TaskFileViewerProps) {
  const [copied, setCopied] = useState(false);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <FileText className="h-8 w-8" />
        <span className="text-sm">Select a file to view its content</span>
      </div>
    );
  }

  const handleCopy = async () => {
    await navigator.clipboard.writeText(file.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([file.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold font-mono">{file.name}</span>
          <span className="text-[10px] text-muted-foreground">
            {file.lines} Lines &middot; {formatFileSize(file.size_bytes)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded transition-colors"
          >
            <Copy className="h-3 w-3" />
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/60 rounded transition-colors"
          >
            <Download className="h-3 w-3" />
            Download
          </button>
        </div>
      </div>
      <CodeBlock content={file.content} language={file.language} />
    </div>
  );
}
