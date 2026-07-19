import Link from "next/link";
import { SignalSphere } from "@/components/brand/SignalSphere";
import { cn } from "@/lib/utils";

type BrandMarkProps = {
  href?: string;
  size?: number;
  className?: string;
};

/**
 * BrandMark — the app identity lockup. Symbol-only; ships without a name.
 */
export function BrandMark({ href = "/", size = 32, className }: BrandMarkProps) {
  return (
    <Link
      href={href}
      aria-label="Home"
      className={cn(
        "flex items-center px-1 text-foreground transition-colors hover:bg-muted/40",
        className,
      )}
    >
      <SignalSphere size={size} decorative />
    </Link>
  );
}
