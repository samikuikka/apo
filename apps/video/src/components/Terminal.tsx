import { useCurrentFrame } from "remotion";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useAppear, useTyped } from "../lib/beat";

export type TerminalLine = {
  text: string;
  at: number;
  tone?: "muted" | "body";
  /** Braille spinner instead of static text tail. */
  spinner?: boolean;
};

/**
 * A CLI moment: the command types itself out, then output lines land beneath
 * it. The braille spinner sells "the real agent is working".
 */
export const Terminal = ({
  command,
  startFrame = 0,
  framesPerChar = 1.2,
  width = 1000,
  lines = [],
}: {
  command: string;
  startFrame?: number;
  framesPerChar?: number;
  width?: number;
  lines?: TerminalLine[];
}) => {
  const frame = useCurrentFrame();
  const typed = useTyped(command, startFrame, framesPerChar);
  return (
    <div
      style={{
        width,
        padding: "28px 32px",
        backgroundColor: color.background,
        borderWidth: 1.5,
        borderStyle: "solid",
        borderColor: color.border,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        fontFamily: fontFamilies.mono,
        fontSize: 26,
        textAlign: "left",
      }}
    >
      <div style={{ color: color.foreground }}>
        <span style={{ color: color.success, fontWeight: 600 }}>$ </span>
        {typed.shown}
        {!typed.done && typed.cursorOn && <span style={{ opacity: 0.9 }}>▌</span>}
      </div>
      {lines.map((line, index) => (
        <TerminalOutputLine key={index} line={line} frame={frame} />
      ))}
    </div>
  );
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const TerminalOutputLine = ({ line, frame }: { line: TerminalLine; frame: number }) => {
  const appear = useAppear(line.at);
  return (
    <div
      style={{
        ...appear,
        color: line.tone === "muted" ? color.mutedForeground : color.foreground,
      }}
    >
      {line.spinner ? (
        <>
          <span style={{ color: color.mutedForeground }}>
            {SPINNER[Math.floor(frame / 4) % SPINNER.length]}{" "}
          </span>
          {line.text}
        </>
      ) : (
        line.text
      )}
    </div>
  );
};
