// PROTOTYPE · shared hand-rolled SVG bits for the trends variants. The repo
// has no chart library and the throwaway adds none. No directive on purpose:
// usable from both server and client components.

export function Sparkline({
  values,
  width,
  height,
  max,
}: {
  values: (number | null)[];
  width: number;
  height: number;
  /** Fixed domain top (rate strips pin 1); otherwise the data max. */
  max?: number;
}) {
  const pad = 2;
  const numeric = values.filter((v): v is number => v !== null);
  if (values.length < 2 || numeric.length < 2) return null;
  const top = max ?? Math.max(...numeric);
  const span = top || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => height - pad - (v / span) * (height - 2 * pad);

  const segments: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null) {
      if (current.length > 1) segments.push(current);
      current = [];
    } else {
      current.push(`${x(i)},${y(value)}`);
    }
  }
  if (current.length > 1) segments.push(current);

  return (
    <svg
      role="img"
      aria-label={`${numeric.length} points`}
      width={width}
      height={height}
      className="text-foreground"
    >
      {segments.map((points, i) => (
        <polyline
          key={i}
          points={points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}
