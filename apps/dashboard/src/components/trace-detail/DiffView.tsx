"use client";

import { useState } from "react";

interface DiffViewProps {
  original: string;
  corrected: string;
}

type DisplayMode = "diff" | "original" | "corrected";

export function DiffView({ original, corrected }: DiffViewProps) {
  const [mode, setMode] = useState<DisplayMode>("diff");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <ModeButton active={mode === "diff"} onClick={() => setMode("diff")}>
          Diff
        </ModeButton>
        <ModeButton
          active={mode === "original"}
          onClick={() => setMode("original")}
        >
          Original
        </ModeButton>
        <ModeButton
          active={mode === "corrected"}
          onClick={() => setMode("corrected")}
        >
          Corrected
        </ModeButton>
      </div>

      <div className="border border-border/60 bg-muted/10 overflow-auto max-h-[400px]">
        {mode === "diff" && (
          <DiffLines original={original} corrected={corrected} />
        )}
        {mode === "original" && <TextBlock text={original} />}
        {mode === "corrected" && <TextBlock text={corrected} />}
      </div>
    </div>
  );
}

function DiffLines({ original, corrected }: { original: string; corrected: string }) {
  const hunks = computeLineDiff(original, corrected);

  return (
    <div className="text-xs font-mono">
      {hunks.map((hunk, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key
        <DiffLine key={i} hunk={hunk} />
      ))}
    </div>
  );
}

interface DiffHunk {
  type: "equal" | "removed" | "added";
  text: string;
}

function computeLineDiff(original: string, corrected: string): DiffHunk[] {
  const origLines = original.split("\n");
  const corrLines = corrected.split("\n");
  const hunks: DiffHunk[] = [];

  let oi = 0;
  let ci = 0;

  while (oi < origLines.length || ci < corrLines.length) {
    if (oi < origLines.length && ci < corrLines.length) {
      if (origLines[oi] === corrLines[ci]) {
        hunks.push({ type: "equal", text: origLines[oi] });
        oi++;
        ci++;
      } else {
        let matchDist = findNextMatch(origLines, corrLines, oi, ci);
        if (matchDist.origSkip === 0 && matchDist.corrSkip === 0) {
          hunks.push({ type: "removed", text: origLines[oi] });
          hunks.push({ type: "added", text: corrLines[ci] });
          oi++;
          ci++;
        } else if (
          matchDist.origSkip <= matchDist.corrSkip &&
          matchDist.origSkip < 5
        ) {
          for (let k = 0; k < matchDist.origSkip; k++) {
            hunks.push({ type: "removed", text: origLines[oi] });
            oi++;
          }
        } else if (matchDist.corrSkip < 5) {
          for (let k = 0; k < matchDist.corrSkip; k++) {
            hunks.push({ type: "added", text: corrLines[ci] });
            ci++;
          }
        } else {
          hunks.push({ type: "removed", text: origLines[oi] });
          hunks.push({ type: "added", text: corrLines[ci] });
          oi++;
          ci++;
        }
      }
    } else if (oi < origLines.length) {
      hunks.push({ type: "removed", text: origLines[oi] });
      oi++;
    } else {
      hunks.push({ type: "added", text: corrLines[ci] });
      ci++;
    }
  }

  return hunks;
}

function findNextMatch(
  origLines: string[],
  corrLines: string[],
  oi: number,
  ci: number,
): { origSkip: number; corrSkip: number } {
  let origSkip = 0;
  let corrSkip = 0;

  for (let i = oi + 1; i < Math.min(oi + 5, origLines.length); i++) {
    const idx = corrLines.indexOf(origLines[i], ci);
    if (idx >= ci && idx < ci + 5) {
      origSkip = i - oi;
      corrSkip = idx - ci;
      break;
    }
  }

  return { origSkip, corrSkip };
}

function DiffLine({ hunk }: { hunk: DiffHunk }) {
  const bgClass =
    hunk.type === "removed"
      ? "bg-destructive/10 text-destructive"
      : hunk.type === "added"
        ? "bg-success/10 text-success"
        : "text-foreground";
  const prefix = hunk.type === "removed" ? "-" : hunk.type === "added" ? "+" : " ";
  const prefixColor =
    hunk.type === "removed"
      ? "text-destructive"
      : hunk.type === "added"
        ? "text-success"
        : "text-muted-foreground";

  return (
    <div className={`${bgClass} px-3 py-0.5 border-b border-border/30 last:border-b-0`}>
      <span className={`${prefixColor} select-none mr-2`}>{prefix}</span>
      {hunk.text}
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-2.5 text-xs font-mono text-foreground">
      {text}
    </pre>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? "border border-border/80 bg-muted/10 px-1.5 py-0.5 text-[11px] text-foreground"
          : "px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}
