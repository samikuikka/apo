"use client";

import { useReducedMotion } from "motion/react";
import { SignalSphere } from "./SignalSphere";
import {
  SignalSphereCanvas,
  type SignalSphereMotionPreset,
} from "./SignalSphereCanvas";

type SignalSphereProps = React.ComponentProps<typeof SignalSphere>;
type AnimatedSignalSphereProps = SignalSphereProps & {
  preset?: SignalSphereMotionPreset;
};

/**
 * AnimatedSignalSphere — live canvas renderer for richer brand motion.
 *
 * Respects prefers-reduced-motion by falling back to the static SVG asset.
 */
export function AnimatedSignalSphere({
  size = 48,
  className,
  title,
  decorative = true,
  preset = "orbit",
}: AnimatedSignalSphereProps) {
  const prefersReducedMotion = useReducedMotion();

  if (prefersReducedMotion) {
    return <SignalSphere size={size} className={className} title={title} decorative={decorative} />;
  }

  return (
    <SignalSphereCanvas
      size={size}
      className={className}
      title={title}
      decorative={decorative}
      animated
      preset={preset}
    />
  );
}
