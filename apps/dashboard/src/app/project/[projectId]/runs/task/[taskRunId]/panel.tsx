import { cn } from "@/lib/utils";

/** Bordered card section. */
export function Panel({
  children,
  className,
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("overflow-hidden border border-border bg-card/60", className)}>
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}
