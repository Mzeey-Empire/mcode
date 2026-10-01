import { CANONICAL_AGENT_PROGRESS_RECOVERY_MAX, type CanonicalAgentProgressFrame } from "@mcode/contracts";

type BufferedRecovery = { token: symbol; frames: CanonicalAgentProgressFrame[]; events: number; bytes: number; overflowed: boolean };

/** Buffers concurrent pushes until a subscription installs its atomic recovery cut. */
export class CanonicalProgressBuffer {
  private readonly threads = new Map<string, BufferedRecovery>();

  /** Start a recovery, replacing an obsolete request's ownership. */
  begin(threadIds: readonly string[]): symbol {
    const token = Symbol("canonical-recovery");
    for (const threadId of threadIds) this.threads.set(threadId, { token, frames: [], events: 0, bytes: 0, overflowed: false });
    return token;
  }

  /** Returns true when this frame belongs to a pending recovery. */
  buffer(frame: CanonicalAgentProgressFrame): boolean {
    const pending = this.threads.get(frame.threadId);
    if (!pending) return false;
    const events = frame.phase === "recovery" ? frame.retained.length : frame.events.length;
    pending.events += events;
    pending.bytes += new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    if (pending.events > CANONICAL_AGENT_PROGRESS_RECOVERY_MAX || pending.bytes > 16 * 1024 * 1024 || pending.frames.length >= CANONICAL_AGENT_PROGRESS_RECOVERY_MAX) {
      pending.frames = [];
      pending.overflowed = true;
    }
    if (!pending.overflowed) pending.frames.push(frame);
    return true;
  }

  /** Release only buffers still owned by this request, in original arrival order. */
  finish(token: symbol): Array<{ threadId: string; frames: CanonicalAgentProgressFrame[]; overflowed: boolean }> {
    const finished = [];
    for (const [threadId, pending] of this.threads) {
      if (pending.token !== token) continue;
      this.threads.delete(threadId);
      finished.push({ threadId, frames: pending.frames, overflowed: pending.overflowed });
    }
    return finished;
  }
}
