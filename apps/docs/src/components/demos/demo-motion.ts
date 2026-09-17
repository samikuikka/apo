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
  /** Fraction of the element that must be visible to count (default 0). */
  threshold?: number;
}

/**
 * Observes an element and calls back as it enters/leaves the viewport.
 *
 * Returns a disposer. If IntersectionObserver is unavailable, the callback
 * fires once as "visible" and the disposer is a no-op — the demo runs but
 * never pauses (older browsers, rare in practice).
 *
 * The default threshold is 0 (any pixel on screen counts), not a fraction of
 * the element: landing sections and demos are routinely taller than a phone
 * viewport, and with a positive threshold the observer reports "not
 * intersecting" while the element's visible bottom is still on screen —
 * un-revealing exactly the content the reader is scrolled to (e.g. the
 * landing page's regression bars vanished on mobile).
 *
 * @param onTransition receives the new visibility state
 */
export function onVisible(
  element: HTMLElement,
  onTransition: (state: VisibleState) => void,
  { threshold = 0 }: OnVisibleOptions = {},
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
