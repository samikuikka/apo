import type { ReactNode } from "react";

type TokenRule = {
  pattern: RegExp;
  className: string;
};

const COMMON_RULES: TokenRule[] = [
  { pattern: /\/\/.*$|\/\*[\s\S]*?\*\//gm, className: "text-muted-foreground" },
  { pattern: /(["'`])(?:(?!\1|\\).|\\.)*\1/g, className: "text-emerald-600 dark:text-emerald-300" },
  { pattern: /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|void|delete|yield|interface|type|enum|namespace|abstract|implements|readonly|declare|as|is|keyof|infer|never|unknown|any)\b/g, className: "text-purple-600 dark:text-purple-300" },
  { pattern: /\b(?:true|false|null|undefined|NaN|Infinity)\b/g, className: "text-amber-600 dark:text-amber-300" },
  { pattern: /\b\d+\.?\d*(?:e[+-]?\d+)?\b/gi, className: "text-amber-600 dark:text-amber-300" },
  { pattern: /\b(?:def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|raise|pass|break|continue|yield|lambda|and|or|not|is|in|None|True|False|self|async|await|print)\b/g, className: "text-purple-600 dark:text-purple-300" },
];

function applyTokenRules(line: string, rules: TokenRule[]): ReactNode[] {
  const segments: { text: string; className: string }[] = [{ text: line, className: "" }];

  for (const rule of rules) {
    const nextSegments: { text: string; className: string }[] = [];
    for (const seg of segments) {
      if (seg.className !== "") {
        nextSegments.push(seg);
        continue;
      }
      const parts = seg.text.split(rule.pattern);
      const matches = seg.text.match(rule.pattern);
      if (!matches || matches.length === 0) {
        nextSegments.push(seg);
        continue;
      }
      let matchIdx = 0;
      for (const part of parts) {
        if (part !== undefined) {
          nextSegments.push({ text: part, className: "" });
        }
        if (matchIdx < matches.length) {
          nextSegments.push({ text: matches[matchIdx], className: rule.className });
          matchIdx++;
        }
      }
    }
    segments.length = 0;
    segments.push(...nextSegments);
  }

  return segments.map((seg, i) => (
    <span key={`seg-${seg.className}-${i}`} className={seg.className || undefined}>
      {seg.text}
    </span>
  ));
}

function highlightDiffLine(line: string): ReactNode {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) {
    return <span className="text-purple-600 dark:text-purple-300">{line}</span>;
  }
  if (line.startsWith("+")) {
    return <span className="text-emerald-600 dark:text-emerald-300">{line}</span>;
  }
  if (line.startsWith("-")) {
    return <span className="text-red-600 dark:text-red-300">{line}</span>;
  }
  if (line.startsWith("@@")) {
    return <span className="text-amber-600 dark:text-amber-300">{line}</span>;
  }
  return <span>{line}</span>;
}

function highlightMarkdownLine(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
    const headingMatch = remaining.match(/^(#{1,6}\s)/);

    if (headingMatch && parts.length === 0) {
      parts.push(
        <span key={`h-${parts.length}`} className="text-purple-600 dark:text-purple-300 font-bold">
          {headingMatch[1]}
        </span>
      );
      remaining = remaining.slice(headingMatch[1].length);
      continue;
    }

    if (boldMatch && boldMatch.index !== undefined) {
      if (boldMatch.index > 0) {
        parts.push(<span key={`b-pre-${parts.length}`}>{remaining.slice(0, boldMatch.index)}</span>);
      }
      parts.push(
        <span key={`b-${parts.length}`} className="font-bold text-foreground">
          {boldMatch[0]}
        </span>
      );
      remaining = remaining.slice(boldMatch.index + boldMatch[0].length);
      continue;
    }

    if (italicMatch && italicMatch.index !== undefined) {
      if (italicMatch.index > 0) {
        parts.push(<span key={`i-pre-${parts.length}`}>{remaining.slice(0, italicMatch.index)}</span>);
      }
      parts.push(
        <span key={`i-${parts.length}`} className="italic text-muted-foreground">
          {italicMatch[0]}
        </span>
      );
      remaining = remaining.slice(italicMatch.index + italicMatch[0].length);
      continue;
    }

    parts.push(<span key={`rest-${parts.length}`}>{remaining}</span>);
    break;
  }

  return parts;
}

export function highlightLine(line: string, language: string): ReactNode | ReactNode[] {
  if (language === "diff") {
    return highlightDiffLine(line);
  }
  if (language === "markdown") {
    return highlightMarkdownLine(line);
  }
  if (language === "json") {
    return applyTokenRules(line, [
      { pattern: /"[^"\\]*(?:\\.[^"\\]*)*"(?=\s*:)/g, className: "text-sky-600 dark:text-sky-300" },
      { pattern: /"[^"\\]*(?:\\.[^"\\]*)*"/g, className: "text-emerald-600 dark:text-emerald-300" },
      { pattern: /\b(?:true|false|null)\b/g, className: "text-amber-600 dark:text-amber-300" },
      { pattern: /-?\d+\.?\d*([eE][+-]?\d+)?/g, className: "text-amber-600 dark:text-amber-300" },
    ]);
  }
  return applyTokenRules(line, COMMON_RULES);
}
