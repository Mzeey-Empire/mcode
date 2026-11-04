import * as NodeCrypto from "node:crypto";
import { logger } from "../logging/index.js";
import {
  DIAG_CATALOG,
  type BeginPayload,
  type EndPayload,
  type EventName,
  type EventPayload,
  type IdsOf,
  type SpanName,
} from "./catalog.js";
import type { DiagIds, DiagOutcome, DiagRecord } from "./record.js";
import { boundPayload } from "./internal/bound.js";
import { describeError } from "./internal/error-message.js";
import { Sink } from "./internal/sink.js";

const MAX_OPEN_SPANS = 10_000;

type RunMarker = Extract<DiagRecord, { k: "run" }>;
type RunState = RunMarker["state"];

interface OpenSpan {
  ids: DiagIds;
  startedAt: number;
}

/** Options for {@link DiagRecorder.configure}. */
export interface DiagConfiguration {
  /** Directory that receives the recording files. */
  dir?: string;
  /** Whether recording should be on. Omit to keep the current choice. */
  enabled?: boolean;
}

function spanMapKey(channel: string, spanKey: string): string {
  return channel + ":" + spanKey;
}

/** Process-local recorder; providers only emit and the server configures it. */
export class DiagRecorder {
  private requested = false;
  private enabled = false;
  private failed = false;
  private dir?: string;
  private sink?: Sink;
  private readonly runId = NodeCrypto.randomUUID();
  private sequence = 0;
  private readonly openSpans = new Map<string, OpenSpan>();
  private readonly touchedThreads = new Set<string>();

  /** Configure recording without allowing I/O failures to affect product behavior. */
  configure(options: DiagConfiguration): void {
    if (options.dir !== undefined) {
      this.changeDirectory(options.dir);
    }

    const requested = options.enabled ?? this.requested;
    if (this.enabled && !requested) {
      this.stop();
    }
    this.requested = requested;

    if (options.enabled === true) {
      this.clearFailure();
    }
    if (requested && !this.enabled && !this.failed) {
      this.start();
    }
  }

  /** Off recording never evaluates a payload thunk. */
  emit<C extends EventName>(ch: C, ids: IdsOf<C>, payload?: () => EventPayload<C>): void {
    if (!this.enabled) return;
    this.recordSafely(() => {
      const data = boundPayload(payload?.());
      this.write({ ...ids, ...this.stamp(), ch, k: "ev", d: data });
    });
  }

  /** A supplied key permits a different call site to finish the action. */
  begin<C extends SpanName>(
    ch: C,
    key: string | undefined,
    ids: IdsOf<C>,
    payload?: () => BeginPayload<C>,
  ): string {
    if (!this.enabled) return key ?? "";

    const spanKey = key ?? NodeCrypto.randomUUID();
    this.recordSafely(() => {
      const data = boundPayload(payload?.());
      const stamp = this.stamp();
      this.rememberSpan(ch, spanKey, { ids, startedAt: stamp.t });
      this.write({
        ...ids,
        ...stamp,
        ch,
        k: "beg",
        sp: spanKey,
        exp: DIAG_CATALOG[ch].expectMs,
        d: data,
      });
    });
    return spanKey;
  }

  /** Unknown ends are preserved as evidence of unmatched actions. */
  end<C extends SpanName>(
    ch: C,
    spanKey: string,
    outcome: DiagOutcome,
    payload?: () => EndPayload<C>,
  ): void {
    if (!this.enabled) return;
    this.recordSafely(() => {
      const data = boundPayload(payload?.());
      const stamp = this.stamp();
      const mapKey = spanMapKey(ch, spanKey);
      const begin = this.openSpans.get(mapKey);
      this.openSpans.delete(mapKey);
      this.write({
        ...begin?.ids,
        ...stamp,
        ch,
        k: "end",
        sp: spanKey,
        ok: outcome,
        ms: begin ? stamp.t - begin.startedAt : undefined,
        d: data,
      });
    });
  }

  /** Preserves both operation results and the identity of a thrown error. */
  run<C extends SpanName, T>(
    ch: C,
    ids: IdsOf<C>,
    operation: () => Promise<T>,
    payload?: () => BeginPayload<C>,
  ): Promise<T> {
    if (!this.enabled) return operation();
    const spanKey = this.begin(ch, undefined, ids, payload);
    return this.complete(ch, spanKey, operation);
  }

  /** Flush on orderly exit and fatal paths. */
  flushSync(): void {
    this.sink?.flushSync();
  }

  private async complete<C extends SpanName, T>(
    ch: C,
    spanKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const value = await operation();
      this.end(ch, spanKey, "ok");
      return value;
    } catch (error) {
      this.end(ch, spanKey, "error", () => ({ error: describeError(error) }));
      throw error;
    }
  }

  private changeDirectory(nextDir: string): void {
    if (nextDir === this.dir) return;
    if (this.enabled) this.stop();
    this.dir = nextDir;
    this.discardSink();
  }

  private clearFailure(): void {
    if (!this.failed) return;
    this.failed = false;
    this.discardSink();
  }

  private start(): void {
    if (this.dir === undefined) return;
    this.sink ??= this.createSink(this.dir);
    this.enabled = true;
    this.writeMarker("on");
    this.sink.sweepRetention();
  }

  private stop(): void {
    this.writeMarker("off");
    this.flushSync();
    this.enabled = false;
  }

  private createSink(dir: string): Sink {
    return new Sink({
      dir,
      runId: this.runId,
      onFailure: (error) => this.fail(error),
      onDropped: (count) => this.writeMarker("dropped", count),
    });
  }

  private discardSink(): void {
    this.sink = undefined;
    this.touchedThreads.clear();
  }

  private stamp(): { t: number; n: number } {
    this.sequence += 1;
    return { t: Date.now(), n: this.sequence };
  }

  private rememberSpan(ch: string, spanKey: string, span: OpenSpan): void {
    const mapKey = spanMapKey(ch, spanKey);
    if (!this.openSpans.has(mapKey) && this.openSpans.size >= MAX_OPEN_SPANS) {
      this.evictOldestSpan();
    }
    this.openSpans.set(mapKey, span);
  }

  private evictOldestSpan(): void {
    const oldest = this.openSpans.keys().next();
    if (!oldest.done) this.openSpans.delete(oldest.value);
  }

  private write(record: DiagRecord): void {
    if (record.th) this.openThreadFile(record.th);
    this.sink?.write(record);
  }

  private openThreadFile(threadId: string): void {
    if (this.touchedThreads.has(threadId)) return;
    this.touchedThreads.add(threadId);
    this.sink?.write(this.runMarker("on", undefined, threadId));
  }

  private runMarker(state: RunState, dropped?: number, threadId?: string): RunMarker {
    return {
      ...this.stamp(),
      ch: "diag",
      k: "run",
      run: this.runId,
      pid: process.pid,
      state,
      dropped,
      th: threadId,
    };
  }

  private writeMarker(state: RunState, dropped?: number): void {
    this.sink?.write(this.runMarker(state, dropped));
    for (const threadId of this.touchedThreads) {
      this.sink?.write(this.runMarker(state, dropped, threadId));
    }
  }

  private recordSafely(operation: () => void): void {
    try {
      operation();
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.enabled = false;
    if (this.failed) return;
    this.failed = true;
    logger.warn("Diagnostics recording disabled after a failure", { error: describeError(error) });
  }
}

/** Singleton shared by all server and provider taps. */
export const diag = new DiagRecorder();
