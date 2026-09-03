"use client";

import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { cn } from "@/lib/utils";
import { WrapText } from "lucide-react";

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  md: "markdown",
  json: "json",
};

function resolveLang(lang?: string): string {
  if (!lang) return "typescript";
  return LANG_MAP[lang] ?? lang;
}

export function ShikiCodeBlock({
  code,
  language,
  className,
}: {
  code: string;
  language?: string;
  className?: string;
}) {
  const [html, setHtml] = useState<string>("");
  const [wrapped, setWrapped] = useState(false);
  const lang = resolveLang(language);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(code, {
      lang,
      theme: "github-dark",
    }).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className={cn("group/code relative rounded-md border border-border overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5 bg-card">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {lang}
        </span>
        <button type="button"
          onClick={() => setWrapped(!wrapped)}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
            wrapped ? "text-foreground bg-foreground/10" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <WrapText className="h-2.5 w-2.5" />
          {wrapped ? "Wrap" : "No wrap"}
        </button>
      </div>
      {html ? (
        <div
          className={cn(
            "overflow-x-auto text-[13px] leading-[1.6] [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0",
            "[&_code]:!bg-transparent [&_code]:!text-[13px] [&_code]:!leading-[1.6]",
            wrapped && "[&_pre]:!whitespace-pre-wrap [&_pre]:!break-all",
            "!bg-background px-4 py-3",
          )}
          // react-doctor-disable-next-line react-doctor/dangerous-html-sink
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div
          className={cn(
            "overflow-x-auto !bg-background py-3",
          )}
        >
          <pre className="px-4 text-[13px] leading-[1.6] text-muted-foreground">
            {code.split("\n").map((_, i) => (
              <div key={i} className="min-h-[1.6em]" />
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
