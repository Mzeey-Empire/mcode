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
  writing?: { key: string; fd: number; buffer: Buffer; position: number };
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
  private inFlight?: QueuedBatch;
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
   * Finishes queued and in-flight records before exit. Active writes share fixed offsets,
   * so their later async completion cannot append a second copy.
   */
  flushSync(): void {
    this.clearTimer();
    if (this.inFlight) this.writeBatchSync(this.inFlight);
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
    this.inFlight = batch;
    try {
      for (const [key, lines] of batch.files) {
        await this.appendLines(batch, key, lines.join(""));
        batch.files.delete(key);
      }
      this.queuedAndWritingBytes -= batch.bytes;
      batch.bytes = 0;
      this.reportDrops();
    } catch (error) {
      if (batch.files.size > 0) this.markFailed(error, batch);
    } finally {
      this.flushInFlight = false;
      this.inFlight = undefined;
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
    this.writeBatchSync(this.takeBatch());
  }

  private writeBatchSync(batch: QueuedBatch): void {
    if (this.failed) return;
    try {
      for (const [key, lines] of batch.files) {
        const writing = batch.writing;
        if (writing?.key === key) {
          writeAllSync(writing.fd, writing.buffer, writing.position);
        } else {
          this.appendLinesSync(key, lines.join(""));
        }
        batch.files.delete(key);
      }
      this.queuedAndWritingBytes -= batch.bytes;
      batch.bytes = 0;
    } catch (error) {
      this.markFailed(error, batch);
    }
  }

  private reportDrops(): boolean {
    if (this.droppedCount === 0) return false;
    const count = this.droppedCount;
    this.droppedCount = 0;
    this.options.onDropped(count);
    return true;
  }

  private markFailed(error: unknown, batch: QueuedBatch): void {
    if (this.failed) return;
    this.clearTimer();
    const batches = new Set([batch, this.inFlight].filter((value) => value !== undefined));
    for (const pending of batches) {
      for (const lines of pending.files.values()) this.droppedCount += lines.length;
      pending.files.clear();
      pending.bytes = 0;
    }
    for (const lines of this.queued.values()) this.droppedCount += lines.length;
    this.queued.clear();
    this.queuedBytes = 0;
    this.queuedAndWritingBytes = 0;
    this.flushInFlight = true;
    this.reportDrops();
    this.failed = true;
    this.clearTimer();
    for (const [key, lines] of this.takeBatch().files) {
      try {
        this.appendLinesSync(key, lines.join(""));
      } catch {
        // The failure callback below reports disk errors even if their marker cannot be saved.
      }
    }
    this.options.onFailure(error);
  }

  private pathFor(key: string): string {
    return NodePath.join(this.options.dir, key + ".jsonl");
  }

  private async appendLines(batch: QueuedBatch, key: string, text: string): Promise<void> {
    const file = this.pathFor(key);
    // Yield before metadata work too, so crossing the threshold never blocks emit().
    await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true });
    if (!batch.files.has(key)) return;
    const position = this.prepareAppend(key, file, text);
    const fd = NodeFS.openSync(file, NodeFS.constants.O_CREAT | NodeFS.constants.O_RDWR);
    const buffer = Buffer.from(text);
    batch.writing = { key, fd, buffer, position };
    this.fileSizes.set(key, position + buffer.length);
    try {
      let offset = 0;
      while (offset < buffer.length && batch.files.has(key)) {
        offset += await writeAt(fd, buffer, offset, position);
      }
    } catch (error) {
      if (batch.files.has(key)) throw error;
    } finally {
      batch.writing = undefined;
      NodeFS.closeSync(fd);
    }
  }

  private appendLinesSync(key: string, text: string): void {
    const file = this.pathFor(key);
    const size = this.prepareAppend(key, file, text);
    NodeFS.appendFileSync(file, text);
    this.fileSizes.set(key, size + Buffer.byteLength(text));
  }

  private prepareAppend(key: string, file: string, text: string): number {
    const size = this.sizeOfSync(key, file);
    if (!needsRotation(size, text)) return size;
    rotateIfPresentSync(file);
    return 0;
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

function writeAt(fd: number, buffer: Buffer, offset: number, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    NodeFS.write(fd, buffer, offset, buffer.length - offset, position + offset, (error, written) => {
      if (error) reject(error);
      else if (written === 0) reject(new Error("Diagnostics write made no progress"));
      else resolve(written);
    });
  });
}

function writeAllSync(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = NodeFS.writeSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (written === 0) throw new Error("Diagnostics write made no progress");
    offset += written;
  }
}

function rotateIfPresentSync(file: string): void {
  try {
    NodeFS.renameSync(file, previousSegmentPath(file));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
