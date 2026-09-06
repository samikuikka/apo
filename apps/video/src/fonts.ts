import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadNotoSans } from "@remotion/google-fonts/NotoSans";
import { continueRender, delayRender } from "remotion";

// Same families the dashboard uses (docs/design.md): Noto Sans for prose,
// JetBrains Mono for code, ids, and numbers. Two weights per family max,
// matching the "≤2 font weights per view" rule.
const sans = loadNotoSans("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});

const mono = loadJetBrainsMono("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});

// Fonts arrive over the network, so block the first frame until they are in —
// otherwise early stills render with fallback glyphs.
const sansHandle = delayRender("Load Noto Sans");
void sans.waitUntilDone().then(() => continueRender(sansHandle));

const monoHandle = delayRender("Load JetBrains Mono");
void mono.waitUntilDone().then(() => continueRender(monoHandle));

export const fontFamilies = {
  sans: sans.fontFamily,
  mono: mono.fontFamily,
} as const;
