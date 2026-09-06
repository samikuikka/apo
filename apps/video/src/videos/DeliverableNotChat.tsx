import type { ReactNode } from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { Caption, ChapterTag, Em } from "../components/Caption";
import { ChatPanel } from "../components/ChatPanel";
import { CodeWindow, t } from "../components/CodeWindow";
import { DeliverablePanel } from "../components/DeliverablePanel";
import { TestList } from "../components/TestList";
import { VerdictBadge } from "../components/VerdictBadge";
import { Wordmark } from "../components/Wordmark";
import { fontFamilies } from "../fonts";
import { Beat, useAppear } from "../lib/beat";
import { color, stagePadding } from "../theme";

export const DELIVERABLE_DURATION = 1380;

// Beat map (30fps): title 0–120, chat graded 120–480, deliverable graded
// 480–840, side by side 840–1080, code 1080–1320, close 1320–1380.
const TITLE = 120;
const CHAT_GRADED = 360;
const DELIVERABLE_GRADED = 360;
const SIDE_BY_SIDE = 240;
const CODE = 240;
const CLOSE = 60;

export const DeliverableNotChat = () => (
  <AbsoluteFill
    style={{
      backgroundColor: color.background,
      color: color.foreground,
      fontFamily: fontFamilies.sans,
      padding: stagePadding,
    }}
  >
    <Sequence durationInFrames={TITLE}>
      <Beat durationInFrames={TITLE}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 40 }}>
          <ChapterTag>apo — 02</ChapterTag>
          <Caption size="hero">
            Judge the <Em>deliverable</Em>, not the chat.
          </Caption>
        </AbsoluteFill>
      </Beat>
    </Sequence>

    <Sequence from={TITLE} durationInFrames={CHAT_GRADED}>
      <Beat durationInFrames={CHAT_GRADED}>
        <ChatGradedBeat />
      </Beat>
    </Sequence>

    <Sequence from={TITLE + CHAT_GRADED} durationInFrames={DELIVERABLE_GRADED}>
      <Beat durationInFrames={DELIVERABLE_GRADED}>
        <DeliverableGradedBeat />
      </Beat>
    </Sequence>

    <Sequence from={TITLE + CHAT_GRADED + DELIVERABLE_GRADED} durationInFrames={SIDE_BY_SIDE}>
      <Beat durationInFrames={SIDE_BY_SIDE}>
        <SideBySideBeat />
      </Beat>
    </Sequence>

    <Sequence from={TITLE + CHAT_GRADED + DELIVERABLE_GRADED + SIDE_BY_SIDE} durationInFrames={CODE}>
      <Beat durationInFrames={CODE}>
        <CodeBeat />
      </Beat>
    </Sequence>

    <Sequence from={DELIVERABLE_DURATION - CLOSE} durationInFrames={CLOSE}>
      <Beat durationInFrames={CLOSE}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <Wordmark size={88} tagline />
        </AbsoluteFill>
      </Beat>
    </Sequence>
  </AbsoluteFill>
);

/**
 * The trap: the conversation sounds perfect, the chat grader passes it, and
 * the artifact is missing half the parties. The stamp flips when the
 * deliverable opens.
 */
const ChatGradedBeat = () => (
  <>
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 64 }}>
      <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "flex-start" }}>
          <ChatPanel
            width={660}
            messages={[
              {
                role: "user",
                at: 10,
                text: "Extract every named party from contract.pdf",
              },
              {
                role: "assistant",
                at: 55,
                text:
                  "Absolutely — I went through the contract and pulled out all the parties. Each one is verified against the source. The complete list is ready!",
              },
            ]}
          />
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <GradeLabel>grades the chat</GradeLabel>
            <VerdictBadge verdict="pass" stampAt={130} />
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "flex-start" }}>
          <DeliverablePanel
            filename="parties.json"
            width={660}
            startFrame={200}
            per={12}
            lines={[
              { text: "{ \"parties\": [", tone: "muted" },
              { text: "  \"Acme Corp\",", tone: "ok" },
              { text: "  \"Globex Industries\",", tone: "ok" },
              { text: "  \"Northwind Traders\",", tone: "missing" },
              { text: "  \"Initech\",", tone: "missing" },
              { text: "  \"Umbrella Corp\"", tone: "missing" },
              { text: "] }", tone: "muted" },
            ]}
          />
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <GradeLabel>the deliverable</GradeLabel>
            <VerdictBadge verdict="fail" stampAt={310} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
    <CaptionSlot>
      <Sequence durationInFrames={180}>
        <Caption sub="most eval tools grade the conversation">
          It <Em>sounds</Em> right.
        </Caption>
      </Sequence>
      <Sequence from={180} durationInFrames={CHAT_GRADED - 180}>
        <Caption sub="2 of 5 parties in the artifact">Polite. Fluent. Wrong.</Caption>
      </Sequence>
    </CaptionSlot>
  </>
);

/** The apo cut: terse chat, complete deliverable, tests on the artifact. */
const DeliverableGradedBeat = () => (
  <>
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 64 }}>
      <div style={{ display: "flex", gap: 48, alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "flex-start" }}>
          <ChatPanel
            width={600}
            messages={[
              { role: "user", at: 10, text: "Extract every named party from contract.pdf" },
              { role: "assistant", at: 45, text: "done" },
            ]}
          />
          <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
            <GradeLabel>the chat</GradeLabel>
            <span style={{ ...gradeMuted }}>says nothing</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "flex-start" }}>
          <DeliverablePanel
            filename="parties.json"
            width={660}
            startFrame={90}
            per={10}
            lines={[
              { text: "{ \"parties\": [", tone: "muted" },
              { text: "  \"Acme Corp\",", tone: "ok" },
              { text: "  \"Globex Industries\",", tone: "ok" },
              { text: "  \"Northwind Traders\",", tone: "ok" },
              { text: "  \"Initech\",", tone: "ok" },
              { text: "  \"Umbrella Corp\"", tone: "ok" },
              { text: "] }", tone: "muted" },
            ]}
          />
          <TestList
            width={660}
            startFrame={200}
            per={15}
            rows={[
              { name: "used-source-document", kind: "code", state: "pass", resolvesAt: 250 },
              { name: "parties-are-complete", kind: "code", state: "pass", resolvesAt: 280 },
              {
                name: "no-false-parties",
                kind: "judge",
                state: "pass",
                resolvesAt: 310,
              },
            ]}
          />
          <VerdictBadge verdict="pass" stampAt={330} scale={1.2} />
        </div>
      </div>
    </AbsoluteFill>
    <CaptionSlot>
      <Caption sub="the artifact is the result">
        apo judges what the agent <Em>produced</Em>.
      </Caption>
    </CaptionSlot>
  </>
);

/** Same run, two verdicts: the chat passes, the deliverable fails. */
const SideBySideBeat = () => (
  <>
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 72 }}>
      <div style={{ display: "flex", gap: 56, alignItems: "stretch" }}>
        <MiniPanel label="the chat" at={15}>
          <div style={{ ...miniBody }}>
            “Absolutely — all parties extracted and verified. The complete list is ready!”
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <VerdictBadge verdict="pass" stampAt={60} />
            <span style={gradeMuted}>fluent · complete-sounding</span>
          </div>
        </MiniPanel>
        <MiniPanel label="the deliverable" at={45}>
          <div style={{ ...miniBody, fontFamily: fontFamilies.mono, fontSize: 25 }}>
            parties.json — 2 of 5 parties
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <VerdictBadge verdict="fail" stampAt={90} />
            <span style={gradeMuted}>terse · true</span>
          </div>
        </MiniPanel>
      </div>
    </AbsoluteFill>
    <CaptionSlot>
      <Caption>
        What the agent <Em>produced</Em> matters more than what it <Em>said</Em>.
      </Caption>
    </CaptionSlot>
  </>
);

const CodeBeat = () => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 60 }}>
    <CodeWindow
      filename="contract-parties.eval.ts"
      width={1060}
      fontSize={27}
      startFrame={12}
      lines={[
        [t("test", "strong"), t("(", "punct"), t("\"parties-are-complete\"", "string"), t(", ", "punct"), t("async", "strong"), t(" (t, { deliverables }) ", "plain"), t("=>", "punct"), t(" {", "plain")],
        [t("  t.", "plain"), t("check", "strong"), t("(", "punct"), t("deliverables.parties", "plain"), t(", ", "punct"), t("matches", "strong"), t("(partiesSchema));", "plain")],
        [t("  await", "strong"), t(" t.", "plain"), t("judge", "strong"), t("(", "punct"), t("deliverables.parties", "plain"), t(",", "punct")],
        [t("    ", "plain"), t("\"PASS when every named party is captured without false positives.\"", "string"), t(");", "plain")],
        [t("});", "plain")],
      ]}
    />
    <Caption sub="both are just tests">
      Assert on the artifact — in code, or with a judge.
    </Caption>
  </AbsoluteFill>
);

/** Tiny mono label marking what a grader is looking at. */
const GradeLabel = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontFamily: fontFamilies.mono,
      fontSize: 23,
      letterSpacing: "0.18em",
      color: color.mutedForeground,
    }}
  >
    {children}
  </div>
);

const gradeMuted = {
  fontFamily: fontFamilies.mono,
  fontSize: 23,
  color: color.faintForeground,
} as const;

/** A small labeled panel for the side-by-side comparison. */
const MiniPanel = ({
  label,
  at,
  children,
}: {
  label: string;
  at: number;
  children: ReactNode;
}) => {
  const appear = useAppear(at);
  return (
    <div
      style={{
        ...appear,
        display: "flex",
        flexDirection: "column",
        gap: 26,
        padding: 32,
        width: 620,
        backgroundColor: color.card,
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: color.border,
      }}
    >
      <div
        style={{
          fontFamily: fontFamilies.mono,
          fontSize: 21,
          letterSpacing: "0.2em",
          color: color.mutedForeground,
        }}
      >
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
};

const miniBody = {
  fontSize: 27,
  lineHeight: 1.5,
  color: color.foreground,
} as const;

/** Bottom-anchored caption slot, shared by all content beats. */
const CaptionSlot = ({ children }: { children: ReactNode }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "flex-end", paddingBottom: 24 }}>
    {children}
  </AbsoluteFill>
);
