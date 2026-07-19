export function getHeatmapColor(value: number, max: number): string {
  if (max <= 0) return "text-muted-foreground";
  const ratio = value / max;
  if (ratio > 0.5) return "text-red-500";
  if (ratio > 0.25) return "text-orange-500";
  if (ratio > 0.1) return "text-amber-500";
  return "text-muted-foreground";
}
