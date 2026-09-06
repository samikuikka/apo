import type { CSSProperties } from "react";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useStamp } from "../lib/beat";

export type Verdict = "pass" | "fail" | "error";

const VERDICT_TEXT: Record<Verdict, string> = {
  pass: "PASS",
  fail: "FAIL",
  error: "ERROR",
};

const VERDICT_COLOR: Record<Verdict, string> = {
  pass: color.success,
  fail: color.destructive,
  error: color.warning,
};

type VerdictBadgeProps = {
  verdict: Verdict;
  /** 1 = default card badge; scale up for run-header stamps. */
  scale?: number;
  /** Frame the badge stamps in. Before it, the badge is invisible. */
  stampAt?: number;
};

/** Square verdict badge. Color = state, the one place color is allowed. */
export const VerdictBadge = ({ verdict, scale = 1, stampAt = 0 }: VerdictBadgeProps) => {
  const verdictColor = VERDICT_COLOR[verdict];
  const stamp = useStamp(stampAt);
  const style: CSSProperties = {
    ...stamp,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: `${10 * scale}px ${18 * scale}px`,
    borderWidth: 1.5 * scale,
    borderStyle: "solid",
    borderColor: verdictColor,
    backgroundColor: `${verdictColor}22`,
    fontFamily: fontFamilies.mono,
    fontSize: 24 * scale,
    fontWeight: 600,
    letterSpacing: "0.22em",
    color: verdictColor,
  };
  return <span style={style}>{VERDICT_TEXT[verdict]}</span>;
};
