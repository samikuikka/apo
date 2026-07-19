import { SignalSphere } from "@/components/brand/SignalSphere";
import { AnimatedSignalSphere } from "@/components/brand/AnimatedSignalSphere";

export const dynamic = "force-dynamic";

export const metadata = { title: "Brand Preview" };

// Below 48px the component swaps to the small variant (fewer, larger dots)
// so each dot survives the downscale. 16/20px are the real UI sizes that
// broke before (favicon + topbar) — keep them in the preview.
const SMALL_VARIANT_SIZES = [16, 20, 24, 28, 32, 40, 48];
const CANONICAL_SIZES = [64, 96, 128, 192, 320];

export default function BrandPreview() {
  return (
    <main className="h-screen overflow-y-auto bg-background p-8">
      <div className="mx-auto max-w-4xl space-y-12 pb-24">
        <h1 className="text-lg font-semibold text-foreground">Signal Sphere Preview</h1>

        <section className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-muted-foreground">
              Small variant — UI sizes (up to 48px)
            </h2>
            <p className="text-xs text-muted-foreground/70">
              <span className="font-mono">signal-sphere-small.png</span> · ~110 larger dots,
              pre-rasterized so every size renders crisp (SVG aliases at 24/32px). 16px is the
              favicon target.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-6 rounded-lg border border-border/40 bg-card/30 p-6">
            {SMALL_VARIANT_SIZES.map((s) => (
              <div key={s} className="flex flex-col items-center gap-2">
                <SignalSphere size={s} />
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-muted-foreground">{s}px</span>
                  <span className="text-[9px] text-muted-foreground/50">small</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-border/40 bg-black p-4">
            <span className="text-xs text-muted-foreground/70">Topbar context →</span>
            <SignalSphere size={32} />
            <span className="text-[10px] text-muted-foreground/50">32px (BrandMark)</span>
          </div>
        </section>

        <section className="space-y-4">
          <div className="space-y-1">
            <h2 className="text-sm font-medium text-muted-foreground">
              Canonical — large sizes (64px and up)
            </h2>
            <p className="text-xs text-muted-foreground/70">
              <span className="font-mono">signal-sphere.svg</span> · ~540 dots. Same geometry the
              animated canvas uses.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-6 rounded-lg border border-border/40 bg-card/30 p-6">
            {CANONICAL_SIZES.map((s) => (
              <div key={s} className="flex flex-col items-center gap-2">
                <SignalSphere size={s} />
                <div className="flex flex-col items-center">
                  <span className="text-[10px] text-muted-foreground">{s}px</span>
                  <span className="text-[9px] text-muted-foreground/50">canonical</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Canonical logo at 96px</h2>
          <div className="flex items-center justify-center rounded-lg border border-border/40 bg-black p-8">
            <SignalSphere size={96} />
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-medium text-muted-foreground">Animated presets</h2>
          <div className="grid gap-6 rounded-lg border border-border/40 bg-black p-8 md:grid-cols-2 xl:grid-cols-6">
            <div className="flex flex-col items-center gap-4">
              <AnimatedSignalSphere size={192} preset="orbit" />
              <span className="text-xs text-muted-foreground">Orbit</span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <AnimatedSignalSphere size={192} preset="parallax" />
              <span className="text-xs text-muted-foreground">Parallax</span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <AnimatedSignalSphere size={192} preset="ripple" />
              <span className="text-xs text-muted-foreground">Ripple</span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <AnimatedSignalSphere size={192} preset="resolve" />
              <span className="text-xs text-muted-foreground">Resolve</span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <AnimatedSignalSphere size={192} preset="compress" />
              <span className="text-xs text-muted-foreground">Compress</span>
            </div>
            <div className="flex flex-col items-center gap-4">
              <AnimatedSignalSphere size={192} preset="sequence" />
              <span className="text-xs text-muted-foreground">Sequence</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
