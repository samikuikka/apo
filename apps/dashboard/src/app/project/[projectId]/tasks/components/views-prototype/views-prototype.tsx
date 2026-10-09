"use client";

// PROTOTYPE (throwaway) — the mount for the Tasks-page views chrome
// variants, gated by ?vproto= on the real route. The parent passes real
// data (tasks, model/effort palette, saved views as seeds); every variant
// manages view state locally and never writes a saved view. Flip variants
// with the floating bottom bar or ←/→. Goes away with this directory.

import { VariantBaseline } from "./variant-baseline";
import { VariantA } from "./variant-a";
import { VariantB } from "./variant-b";
import { VariantC } from "./variant-c";
import { VariantD } from "./variant-d";
import { ProtoSwitcher, type VariantEntry } from "./proto-kit";
import type { VariantProps } from "./proto-state";

const VARIANTS: VariantEntry[] = [
  { key: "cur", label: "Baseline — today's UI" },
  { key: "a", label: "A — Filter chips + views menu" },
  { key: "b", label: "B — Minimal tabs" },
  { key: "c", label: "C — Cohort overview band" },
  { key: "d", label: "D — Compare matrix (no views)" },
];

export function ViewsPrototype({ variantKey, ...props }: VariantProps & { variantKey: string }) {
  const key = VARIANTS.some((v) => v.key === variantKey) ? variantKey : "cur";
  return (
    <>
      {key === "cur" && <VariantBaseline {...props} />}
      {key === "a" && <VariantA {...props} />}
      {key === "b" && <VariantB {...props} />}
      {key === "c" && <VariantC {...props} />}
      {key === "d" && <VariantD {...props} />}
      {process.env.NODE_ENV !== "production" && (
        <ProtoSwitcher variants={VARIANTS} current={key} />
      )}
    </>
  );
}
