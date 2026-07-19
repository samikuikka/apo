/**
 * Shared motion helpers for the docs concept demos.
 *
 * Two concerns, both small:
 *  - prefersReducedMotion(): every demo freezes to a representative static
 *    frame when true (see docs/design.md "Motion").
 *  - onVisible(): start the demo when it scrolls into view, stop when it
 *    leaves — so off-screen demos never burn cycles. Mirrors flue's
 *    IntersectionObserver pattern, without the WebGL dispose machinery.
 */

/** True when the user has asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type VisibleState = "entering" | "visible" | "leaving" | "hidden";

export interface OnVisibleOptions {
  /** Fraction of the element that must be visible to count (default 0.4). */
  threshold?: number;
}

/**
 * Observes an element and calls back as it enters/leaves the viewport.
 *
 * Returns a disposer. If IntersectionObserver is unavailable, the callback
 * fires once as "visible" and the disposer is a no-op — the demo runs but
 * never pauses (older browsers, rare in practice).
 *
 * @param onTransition receives the new visibility state
 */
export function onVisible(
  element: HTMLElement,
  onTransition: (state: VisibleState) => void,
  { threshold = 0.4 }: OnVisibleOptions = {},
): () => void {
  if (!("IntersectionObserver" in window)) {
    onTransition("visible");
    return () => {};
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        onTransition(entry.isIntersecting ? "visible" : "hidden");
      }
    },
    { threshold },
  );

  observer.observe(element);
  return () => observer.disconnect();
}
