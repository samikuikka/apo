import type { ReactNode } from "react";
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { SignalSphereAnimated } from "../components/SignalSphereAnimated";
import { AppFrame } from "../components/AppFrame";
import { Caption, Em } from "../components/Caption";
import { CodeWindow, t } from "../components/CodeWindow";
import { SpineRing } from "../components/SpineRing";
import { Terminal } from "../components/Terminal";
import { TestList } from "../components/TestList";
import { TraceTree } from "../components/TraceTree";
import { VerdictBadge } from "../components/VerdictBadge";
import { fontFamilies } from "../fonts";
import { ramp, useSlide } from "../lib/beat";
import { color, stagePadding } from "../theme";

export const THE_LOOP_DURATION = 1500;

// The red thread: one walk around the loop, node by node. The ring is
// mounted ONCE at the composition root and never re-mounts — its token
// glides node-to-node from the global frame while the scenes beside it
// slide in and out. Lap one fails at the verdict; lap two — same tests,
// changed implementation — passes and exits.
//
// Beat map (30fps): title 140 · map 90 · run 190 · verdict 180 ·
// evidence 190 · improve 170 · run-again 130 · pass 140 · outro 270.
const TITLE_END = 140;
const RING_SIZE = 500;
const RAIL_GAP = 64;
const SCENE_LEFT = stagePadding + RING_SIZE + RAIL_GAP;
const TRAVEL_FRAMES = 20;
const OVERLAP = 12;
const OUTRO_START = 1230;

const LOOP_NODES: [string, string, string, string] = [
  "Run agent",
  "Verdict",
  "Evidence",
  "Improve",
];

/** Node arrivals: where the token is coming from and going, per phase start. */
const NODE_PHASES = [
  { start: 230, from: 0, to: 0 },
  { start: 420, from: 0, to: 1 },
  { start: 600, from: 1, to: 2 },
  { start: 790, from: 2, to: 3 },
  { start: 960, from: 3, to: 0 },
  { start: 1090, from: 0, to: 1 },
] as const;

/** Scene slides, in order; each overlaps the next by OVERLAP frames. */
const SCENES = [
  { start: 140, render: BuildScene },
  { start: 230, render: RunScene },
  { start: 420, render: VerdictScene },
  { start: 600, render: EvidenceScene },
  { start: 790, render: ImproveScene },
  { start: 960, render: RunAgainScene },
  { start: 1090, render: PassScene },
  { start: OUTRO_START, render: OutroScene },
] as const;

export const TheLoop = () => (
  <AbsoluteFill
    style={{
      backgroundColor: color.background,
      color: color.foreground,
      fontFamily: fontFamilies.sans,
    }}
  >
    <Sequence durationInFrames={TITLE_END}>
      <TitleCard />
    </Sequence>

    {/* The persistent left rail — never inside a scene Sequence, so it never
        flickers between phases. All state derives from the global frame. */}
    <LoopRail />

    {SCENES.map((scene, index) => {
      const next = SCENES[index + 1]?.start;
      const duration = (next !== undefined ? next + OVERLAP : THE_LOOP_DURATION) - scene.start;
      const nextLocal = next !== undefined ? next - scene.start : undefined;
      return (
        <Sequence key={scene.start} from={scene.start} durationInFrames={duration}>
          <Scene next={nextLocal} fullBleed={scene.start === OUTRO_START}>
            <scene.render />
          </Scene>
        </Sequence>
      );
    })}
  </AbsoluteFill>
);

/**
 * Editorial title: the signal sphere huge and half off-screen at the left —
 * the logo IS the composition — with the apo wordmark and the title beside
 * its lit edge.
 */
const TitleCard = () => {
  const frame = useCurrentFrame();
  const fadeOut = 1 - ramp(frame, TITLE_END - OVERLAP, OVERLAP);
  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <div style={{ position: "absolute", left: -440, top: 50 }}>
        <SignalSphereAnimated size={980} />
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          top: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: 24,
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 84, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>
          apo
        </span>
        <span style={{ fontSize: 132, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>
          The Loop
        </span>
        <span
          style={{
            fontFamily: fontFamilies.mono,
            fontSize: 27,
            color: color.mutedForeground,
            letterSpacing: "0.04em",
            marginTop: 20,
          }}
        >
          specify the capability — then run the loop until it holds
        </span>
      </div>
    </AbsoluteFill>
  );
};

/** The always-on-the-left loop map. */
const LoopRail = () => {
  const frame = useCurrentFrame();
  const phase = [...NODE_PHASES].reverse().find((node) => frame >= node.start);
  const fadeOut = 1 - ramp(frame, OUTRO_START, OVERLAP);
  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-start",
        paddingLeft: stagePadding,
        paddingTop: 220,
        paddingBottom: stagePadding,
        opacity: fadeOut,
      }}
    >
      <SpineRing
        size={RING_SIZE}
        nodes={LOOP_NODES}
        fromIndex={phase?.from ?? 0}
        activeIndex={phase?.to ?? 0}
        travelProgress={phase !== undefined ? Math.min(1, (frame - phase.start) / TRAVEL_FRAMES) : 0}
        dwellStart={(phase?.start ?? 0) + TRAVEL_FRAMES}
        verdict={frame >= 1090 ? "pass" : frame >= 420 ? "fail" : "pending"}
        runLabel={frame >= 960 ? "run 2 / 2" : frame >= 230 ? "run 1 / 2" : undefined}
        revealAt={TITLE_END + 5}
        tokenVisible={frame >= 225}
      />
    </AbsoluteFill>
  );
};

/** A scene slide: enters from the right, slides out left while the next enters. */
const Scene = ({
  next,
  fullBleed = false,
  children,
}: {
  next?: number;
  fullBleed?: boolean;
  children: ReactNode;
}) => {
  const slide = useSlide(next, OVERLAP);
  return (
    <AbsoluteFill style={slide}>
      <AbsoluteFill
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          paddingLeft: fullBleed ? 0 : SCENE_LEFT,
          paddingRight: stagePadding,
          paddingTop: fullBleed ? stagePadding : 220,
          paddingBottom: stagePadding,
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

function BuildScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        One lap = <Em>one task run</Em>.
      </Caption>
    }
  >
    <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ fontSize: 56, fontWeight: 600 }}>Four steps. Every run.</div>
      <div style={{ fontFamily: fontFamilies.mono, fontSize: 26, color: color.mutedForeground }}>
        expected → run → verdict → evidence → improve → run again
      </div>
    </div>
  </SceneBody>
  );
}

function RunScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        apo runs your <Em>real</Em> agent — not a prompt in a sandbox.
      </Caption>
    }
  >
    <Terminal
      command="apo task run answer-from-spec"
      startFrame={12}
      lines={[
        { text: "invoking adapter → your real agent", at: 62, tone: "muted" },
        { text: "running", at: 88, spinner: true },
        { text: "deliverable collected · answer.json", at: 142, tone: "muted" },
        { text: "evaluating…", at: 166, spinner: true },
      ]}
    />
  </SceneBody>
  );
}

function VerdictScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        A completed run <Em>passes or fails</Em>.
      </Caption>
    }
  >
    <AppFrame variant="window" breadcrumb="run 1 — breakdown" width={760} contentHeight={300}>
      <div style={{ display: "flex", flexDirection: "column", gap: 22, alignItems: "center" }}>
        <TestList
          width={640}
          startFrame={20}
          per={15}
          rows={[
            { name: "reads-source-first", kind: "code", state: "fail", resolvesAt: 60 },
            { name: "answer-is-correct", kind: "judge", state: "fail", resolvesAt: 85 },
          ]}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <VerdictBadge verdict="fail" stampAt={110} scale={1.2} />
          <span style={{ fontFamily: fontFamilies.mono, fontSize: 26, color: color.mutedForeground }}>
            0/2
          </span>
        </div>
      </div>
    </AppFrame>
  </SceneBody>
  );
}

function EvidenceScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        The trace shows <Em>why</Em>.
      </Caption>
    }
  >
    <AppFrame variant="window" breadcrumb="run 1 — trace" width={900} contentHeight={380}>
      <TraceTree
        width={780}
        startFrame={15}
        per={12}
        lines={[
          { text: "run · answer-from-spec", depth: 0 },
          { text: "├ model · “answer from spec.md”", depth: 1 },
          { text: "│  └ tool · web_search “acme q3 forecast”", depth: 2, tone: "muted" },
          { text: "│     └ 4 results — none authoritative", depth: 3, tone: "muted" },
          { text: "└ deliverable · answer.json", depth: 1 },
          { text: "   └ “Q3 revenue is $4.2M” — not in any source", depth: 2, tone: "fail" },
        ]}
      />
    </AppFrame>
  </SceneBody>
  );
}

function ImproveScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        Change the implementation — <Em>you, or a coding agent</Em>.
      </Caption>
    }
  >
    <AppFrame variant="window" breadcrumb="agent.ts" width={900} contentHeight={340}>
      <CodeWindow
        filename="agent.ts"
        width={760}
        fontSize={26}
        startFrame={15}
        lines={[
          [t("- const answer = await model(prompt)", "del")],
          [t('+ const spec = await readFile("spec.md")', "add")],
          [t("+ const answer = await model(prompt, spec)", "add")],
        ]}
      />
    </AppFrame>
  </SceneBody>
  );
}

function RunAgainScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        Run it <Em>again</Em>.
      </Caption>
    }
  >
    <Terminal
      command="apo task run answer-from-spec"
      startFrame={8}
      framesPerChar={0.8}
      lines={[
        { text: "running", at: 42, spinner: true },
        { text: "evaluating…", at: 76, spinner: true },
      ]}
    />
  </SceneBody>
  );
}

function PassScene() {
  return (
  <SceneBody
    caption={
      <Caption>
        The loop exits when the tests <Em>pass</Em>.
      </Caption>
    }
  >
    <AppFrame variant="window" breadcrumb="run 2 — breakdown" width={760} contentHeight={300}>
      <div style={{ display: "flex", flexDirection: "column", gap: 22, alignItems: "center" }}>
        <TestList
          width={640}
          startFrame={15}
          per={14}
          rows={[
            { name: "reads-source-first", kind: "code", state: "pass", resolvesAt: 50 },
            { name: "answer-is-correct", kind: "judge", state: "pass", resolvesAt: 72 },
          ]}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <VerdictBadge verdict="pass" stampAt={95} scale={1.2} />
          <span style={{ fontFamily: fontFamilies.mono, fontSize: 26, color: color.mutedForeground }}>
            2/2
          </span>
        </div>
      </div>
    </AppFrame>
  </SceneBody>
  );
}

/**
 * The closing bookend: the title's composition mirrored — the big sphere
 * half off-screen on the right, the loop formula and a full-size apo
 * wordmark with its tagline set against it.
 */
function OutroScene() {
  return (
  <AbsoluteFill>
    <Img
      src={staticFile("brand/signal-sphere.svg")}
      style={{ position: "absolute", width: 980, height: 980, right: -440, top: 50 }}
    />
    <div
      style={{
        position: "absolute",
        right: 620,
        top: 0,
        bottom: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "flex-end",
        gap: 30,
        textAlign: "right",
      }}
    >
      <span style={{ fontSize: 140, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>
        apo
      </span>
      <span
        style={{
          fontFamily: fontFamilies.mono,
          fontSize: 27,
          color: color.mutedForeground,
          letterSpacing: "0.04em",
          marginTop: 14,
        }}
      >
        executable definitions of done
      </span>
    </div>
  </AbsoluteFill>
  );
}

/**
 * A scene's right-side content plus its bottom caption. Both share the
 * slide transition of the enclosing Scene.
 */
const SceneBody = ({ caption, children }: { caption: ReactNode; children: ReactNode }) => (
  <>
    {children}
    <CaptionSlot>{caption}</CaptionSlot>
  </>
);

/** Top-anchored caption slot — the narration reads as a headline, seated
 *  well clear of platform player UI at the frame edge. */
const CaptionSlot = ({ children }: { children: ReactNode }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-start", paddingTop: 120 }}>
    {children}
  </AbsoluteFill>
);
