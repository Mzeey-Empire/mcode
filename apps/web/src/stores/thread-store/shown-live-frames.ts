import type { CanonicalAgentProgressFrame } from "@mcode/contracts/models/canonical-agent-progress";

type LiveFrame = Extract<CanonicalAgentProgressFrame, { phase: "live" }>;

/**
 * The last live frame shown per thread record. Live frames change no replica state, so this watermark sits beside
 * the replica: keeping it in the replica would cost a store update for every streamed piece.
 */
export class ShownLiveFrames {
  private readonly shown = new Map<string, { readonly epoch: string; readonly liveSequence: number }>();

  /** False for a frame resent or reordered behind one already shown for its thread in the same epoch. */
  isNew(frame: LiveFrame): boolean {
    const last = this.shown.get(frame.threadId);
    return !last || last.epoch !== frame.epoch || frame.liveSequence > last.liveSequence;
  }

  /** Record a frame once its pieces are shown. */
  remember(frame: LiveFrame): void {
    this.shown.set(frame.threadId, { epoch: frame.epoch, liveSequence: frame.liveSequence });
  }

  /** Drop a cleared thread's watermark. */
  forget(threadId: string): void {
    this.shown.delete(threadId);
  }

  /** Clear every watermark when resetting an isolated test store. */
  reset(): void {
    this.shown.clear();
  }
}

/** Renderer-wide live frame watermarks, one per thread record. */
export const shownLiveFrames = new ShownLiveFrames();
