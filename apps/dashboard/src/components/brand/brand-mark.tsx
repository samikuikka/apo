import Link from "next/link";
import { SignalSphere } from "@/components/brand/SignalSphere";
import { cn } from "@/lib/utils";

type BrandMarkProps = {
  href?: string;
  size?: number;
  className?: string;
};

/**
 * BrandMark — the app identity lockup. The sphere alone reads as a faint
 * smudge at UI sizes, so it always ships with the wordmark beside it.
 */
export function BrandMark({ href = "/", size = 32, className }: BrandMarkProps) {
  return (
    <Link
      href={href}
      aria-label="Home"
      className={cn(
        "flex items-center gap-1.5 px-1 text-foreground transition-colors hover:bg-muted/40",
        className,
      )}
    >
      <SignalSphere size={size} decorative />
      <span className="text-sm font-semibold lowercase tracking-tight">
        apo
      </span>
    </Link>
  );
}
