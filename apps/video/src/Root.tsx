import { Composition } from "remotion";
import { video } from "./theme";
import { DELIVERABLE_DURATION, DeliverableNotChat } from "./videos/DeliverableNotChat";
import { THE_LOOP_DURATION, TheLoop } from "./videos/TheLoop";

export const RemotionRoot = () => (
  <>
    <Composition
      id="TheLoop"
      component={TheLoop}
      durationInFrames={THE_LOOP_DURATION}
      fps={video.fps}
      width={video.width}
      height={video.height}
    />
    <Composition
      id="DeliverableNotChat"
      component={DeliverableNotChat}
      durationInFrames={DELIVERABLE_DURATION}
      fps={video.fps}
      width={video.width}
      height={video.height}
    />
  </>
);
