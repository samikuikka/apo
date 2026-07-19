import { useEffect, useState } from "react";

/**
 * useReducedMotion — true when the user has asked for less motion.
 *
 * Replaces the `motion/react` `useReducedMotion` hook so the docs app avoids
 * pulling the full Framer Motion package for a single matchMedia listener.
 * See docs/design.md "Motion" — every animation freezes to a static frame here.
 */
export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setReduced(media.matches);

    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
