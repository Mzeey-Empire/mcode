import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { logger } from "../../logging/index.js";
import type { DiagRecord } from "../record.js";
import { describeError } from "./error-message.js";
import { applyRetention, RETENTION_INTERVAL_MS } from "./retention.js";

const FLUSH_INTERVAL_MS = 250;
const FLUSH_THRESHOLD_BYTES = 64 * 1024;
const PENDING_CAP_BYTES = 4 * 1024 * 1024;
const SEGMENT_BYTES = 4 * 1024 * 1024;

/** Filesystem keys never incorporate untrusted path components. */
export function recordingFileId(id: string): string {
  if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) return id;
  return NodeCrypto.createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function fileKeyFor(record: DiagRecord, runId: string): string {
  if (record.th) return "t/" + recordingFileId(record.th);
  return "p/" + recordingFileId(runId);
}

function previousSegmentPath(file: string): string {
  return file.replace(/\.jsonl$/, ".1.jsonl");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function needsRotation(size: number, text: string): boolean {
  return size > 0 && size + Buffer.byteLength(text) > SEGMENT_BYTES;
}

interface QueuedBatch {
  files: Map<string, string[]>;
  bytes: number;
}

/** Callbacks and location for one recording directory. */
export interface SinkOptions {
  dir: string;
  runId: string;
  /** Called once when a write fails; the sink accepts no more records afterwards. */
  onFailure(error: unknown): void;
  /** Called after a successful flush with the number of records dropped at the memory cap. */
  onDropped(count: number): void;
}

/**
 * Buffers JSONL lines per file and appends them from the main thread. Appends use the libuv
 * pool, so streaming never waits on the disk. A worker thread would need its own bundle entry
 * in the server build, which is not worth it for a few appends per second.
 */
export class Sink {
  private queued = new Map<string, string[]>();
  private queuedBytes = 0;
  private queuedAndWritingBytes = 0;
  private droppedCount = 0;
  private readonly fileSizes = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushInFlight = false;
  private failed = false;
  private retentionRunning = false;
  private lastRetentionAt = Date.now();

  constructor(private readonly options: SinkOptions) {}

  /** Queue one record, or count it as dropped when the memory cap is reached. */
  write(record: DiagRecord): void {
    if (this.failed) return;

    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (this.queuedAndWritingBytes + bytes > PENDING_CAP_BYTES) {
      this.droppedCount += 1;
      return;
    }

    const key = fileKeyFor(record, this.options.runId);
    const lines = this.queued.get(key) ?? [];
    lines.push(line);
    this.queued.set(key, lines);
    this.queuedBytes += bytes;
    this.queuedAndWritingBytes += bytes;
    this.scheduleFlush();
  }

  /**
   * Writes everything queued before the process exits. A flush already running keeps going on
   * its own; the reader orders records by their stamps, so file order does not matter.
   */
  flushSync(): void {
    this.clearTimer();
    this.writeQueuedSync();
    if (this.reportDrops()) this.writeQueuedSync();
  }

  /** Applies the age and size limits in the background. A failed sweep is logged, not fatal. */
  sweepRetention(): void {
    if (this.retentionRunning || this.failed) return;
    this.retentionRunning = true;
    this.lastRetentionAt = Date.now();
    void this.runRetention(this.lastRetentionAt);
  }

  private async runRetention(now: number): Promise<void> {
    try {
      await applyRetention(this.options.dir, now);
    } catch (error) {
      logger.warn("Diagnostics retention sweep failed", { error: describeError(error) });
    } finally {
      this.retentionRunning = false;
    }
  }

  private scheduleFlush(): void {
    if (this.queuedBytes >= FLUSH_THRESHOLD_BYTES) {
      this.requestFlush();
      return;
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.requestFlush(), FLUSH_INTERVAL_MS);
    // Pending diagnostics must never keep the server alive.
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private requestFlush(): void {
    this.clearTimer();
    if (this.flushInFlight || this.queued.size === 0) return;
    this.flushInFlight = true;
    void this.flushAsync();
  }

  private async flushAsync(): Promise<void> {
    const batch = this.takeBatch();
    try {
      for (const [key, lines] of batch.files) {
        await this.appendLines(key, lines.join(""));
      }
      this.queuedAndWritingBytes -= batch.bytes;
      this.reportDrops();
    } catch (error) {
      this.markFailed(error);
    } finally {
      this.flushInFlight = false;
    }
    this.afterFlush();
  }

  private afterFlush(): void {
    if (this.failed) return;
    if (Date.now() - this.lastRetentionAt >= RETENTION_INTERVAL_MS) this.sweepRetention();
    if (this.queuedBytes > 0) this.scheduleFlush();
  }

  private takeBatch(): QueuedBatch {
    const batch = { files: this.queued, bytes: this.queuedBytes };
    this.queued = new Map();
    this.queuedBytes = 0;
    return batch;
  }

  private writeQueuedSync(): void {
    if (this.failed || this.queued.size === 0) return;
    const batch = this.takeBatch();
    try {
      for (const [key, lines] of batch.files) {
        this.appendLinesSync(key, lines.join(""));
      }
      this.queuedAndWritingBytes -= batch.bytes;
    } catch (error) {
      this.markFailed(error);
    }
  }

  private reportDrops(): boolean {
    if (this.droppedCount === 0) return false;
    const count = this.droppedCount;
    this.droppedCount = 0;
    this.options.onDropped(count);
    return true;
  }

  private markFailed(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.clearTimer();
    this.queued.clear();
    this.queuedBytes = 0;
    this.queuedAndWritingBytes = 0;
    this.options.onFailure(error);
  }

  private pathFor(key: string): string {
    return NodePath.join(this.options.dir, key + ".jsonl");
  }

  private async appendLines(key: string, text: string): Promise<void> {
    const file = this.pathFor(key);
    let size = await this.sizeOf(key, file);
    if (needsRotation(size, text)) {
      await rotateIfPresent(file);
      size = 0;
    }
    await NodeFS.promises.appendFile(file, text);
    this.fileSizes.set(key, size + Buffer.byteLength(text));
  }

  private appendLinesSync(key: string, text: string): void {
    const file = this.pathFor(key);
    let size = this.sizeOfSync(key, file);
    if (needsRotation(size, text)) {
      rotateIfPresentSync(file);
      size = 0;
    }
    NodeFS.appendFileSync(file, text);
    this.fileSizes.set(key, size + Buffer.byteLength(text));
  }

  private async sizeOf(key: string, file: string): Promise<number> {
    const known = this.fileSizes.get(key);
    if (known !== undefined) return known;

    await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true });
    try {
      const stats = await NodeFS.promises.stat(file);
      this.fileSizes.set(key, stats.size);
      return stats.size;
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.fileSizes.set(key, 0);
      return 0;
    }
  }

  private sizeOfSync(key: string, file: string): number {
    const known = this.fileSizes.get(key);
    if (known !== undefined) return known;

    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    try {
      const size = NodeFS.statSync(file).size;
      this.fileSizes.set(key, size);
      return size;
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.fileSizes.set(key, 0);
      return 0;
    }
  }
}

async function rotateIfPresent(file: string): Promise<void> {
  try {
    await NodeFS.promises.rename(file, previousSegmentPath(file));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function rotateIfPresentSync(file: string): void {
  try {
    NodeFS.renameSync(file, previousSegmentPath(file));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
