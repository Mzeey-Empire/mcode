import * as NodeBuffer from "node:buffer";
import * as NodeModule from "node:module";
import type { IPty } from "node-pty";
import type { TerminalPlatform } from "@mcode/contracts";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import {
  PTY_HOST_MAX_DATA_BYTES,
  PTY_HOST_HEARTBEAT_INTERVAL_MS,
  parsePtyHostServerMessage,
  PtyHostServerMessageSchema,
  type PtyHostEvent,
  type PtyHostServerMessage,
} from "./pty-host-protocol.js";
import { createPtyProcessScope } from "./pty-process-scope.js";

const nativeRequire = NodeModule.createRequire(import.meta.url);
const MAX_SESSIONS = 20;
/** Batching window that coalesces PTY bursts into fewer IPC output events. */
const OUTPUT_FLUSH_DELAY_MS = 2;
/** IPC queue level (inbound pending + outbound in-flight) that pauses PTY reads until the pipe drains. */
const OUTPUT_PAUSE_QUEUE_BYTES = 768 * 1024;
/** IPC queue level that resumes a pressure-paused PTY; the band below pause avoids flapping. */
const OUTPUT_RESUME_QUEUE_BYTES = 512 * 1024;
/** Per-session pending bound; beyond it the session is killed so one flood cannot wedge the host. */
const SESSION_MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Longest an exited session may wait for pending output to drain before the exit publishes anyway. */
const EXIT_OUTPUT_DEADLINE_MS = 2_000;

/** Containment operations owned by one PTY host session. */
export interface PtyProcessScope {
  readonly mechanism: "job-object" | "process-group";
  readonly processGroupId: string;
  establish(): Promise<boolean>;
  hasChildren(): Promise<boolean>;
  close(graceful?: boolean): Promise<void>;
  dispose(): void;
}

/** Construction options for the isolated PTY host runtime. */
export interface PtyHostProcessRuntimeOptions {
  readonly platform: TerminalPlatform;
  readonly hostRuntime: Pick<HostRuntime, "platform" | "architecture">;
  readonly nativeAbi: string;
  readonly publish: (event: PtyHostEvent) => void;
  readonly queueBytes?: () => number;
  readonly spawnPty?: typeof import("node-pty").spawn;
  readonly createScope?: (rootPid: number) => PtyProcessScope;
}

interface HostSession {
  readonly sessionId: string;
  readonly pty: IPty;
  readonly scope: PtyProcessScope;
  readonly dataDisposable: { dispose(): void };
  readonly exitDisposable: { dispose(): void };
  commandSeq: bigint;
  outputSeq: bigint;
  pendingOutput: NodeBuffer.Buffer[];
  pendingOutputBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pausedForPressure: boolean;
  pressureRetryScheduled: boolean;
  exited: { readonly code: number; readonly signal: number | null } | null;
  exitDeadline: ReturnType<typeof setTimeout> | null;
  closeReason:
    | "natural"
    | "user-close"
    | "host-crash"
    | "containment-failure"
    | "protocol-failure";
  exitPromise: Promise<void>;
  resolveExit: () => void;
}

/** Runs native PTYs behind the strict version 1 private host protocol. */
export class PtyHostProcessRuntime {
  private readonly sessions = new Map<string, HostSession>();
  private generation: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(private readonly options: PtyHostProcessRuntimeOptions) {}

  /** Validates and applies one server message. */
  async receive(value: unknown): Promise<void> {
    if (this.disposed) throw new Error("PTY host runtime is stopped");
    const message = this.parseServerMessage(value);
    if (this.generation === null) {
      return this.receiveHandshake(message);
    }
    return this.handleMessage(message);
  }

  private parseServerMessage(value: unknown): PtyHostServerMessage {
    return this.generation === null
      ? PtyHostServerMessageSchema().parse(value)
      : parsePtyHostServerMessage(value, this.generation);
  }

  private receiveHandshake(message: PtyHostServerMessage): void {
    if (message.kind !== "handshake") {
      throw new Error("PTY host handshake is required");
    }
    this.acceptHandshake(message);
  }

  private async handleMessage(message: PtyHostServerMessage): Promise<void> {
    switch (message.kind) {
      case "handshake":
        throw new Error("PTY host handshake is already complete");
      case "create":
        await this.create(message);
        return;
      case "command.input":
      case "command.resize":
        this.applyCommand(message);
        return;
      case "inspectChildren": {
        const session = this.requireSession(message.sessionId);
        this.options.publish({
          contractVersion: 1,
          kind: "children",
          sessionId: message.sessionId,
          hostGeneration: message.hostGeneration,
          hasChildren: await session.scope.hasChildren(),
        });
        return;
      }
      case "close":
        await this.closeSession(
          message.sessionId,
          "user-close",
          message.closeSeq,
          message.reason === "app-shutdown",
        );
        return;
      case "probe":
        this.publishHeartbeat();
        return;
      case "shutdown":
        await Promise.all(
          [...this.sessions.keys()].map((sessionId) =>
            this.closeSession(sessionId, "user-close", undefined, true),
          ),
        );
        await this.dispose();
    }
  }

  /** Stops heartbeat publication and force-releases remaining native handles. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const session of this.sessions.values()) {
      if (session.flushTimer !== null) clearTimeout(session.flushTimer);
      if (session.exitDeadline !== null) clearTimeout(session.exitDeadline);
      session.pendingOutput = [];
      session.pendingOutputBytes = 0;
      session.dataDisposable.dispose();
      session.exitDisposable.dispose();
      session.scope.dispose();
      session.resolveExit();
    }
    this.sessions.clear();
  }

  private acceptHandshake(
    message: Extract<PtyHostServerMessage, { kind: "handshake" }>,
  ): void {
    if (message.platform !== this.options.platform)
      throw new Error("PTY host platform mismatch");
    this.generation = message.requestedGeneration;
    this.options.publish({
      contractVersion: 1,
      kind: "ready",
      hostGeneration: message.requestedGeneration,
      platform: this.options.platform,
      nativeAbi: this.options.nativeAbi,
      capabilities: {
        pty: this.options.platform === "windows" ? "conpty" : "posix-pty",
        containment:
          this.options.platform === "windows" ? "job-object" : "process-group",
        maxSessions: 20,
        protocolVersion: 1,
      },
    });
    this.heartbeatTimer = setInterval(
      () => this.publishHeartbeat(),
      PTY_HOST_HEARTBEAT_INTERVAL_MS,
    );
  }

  private async create(
    message: Extract<PtyHostServerMessage, { kind: "create" }>,
  ): Promise<void> {
    if (this.sessions.size >= MAX_SESSIONS)
      throw new Error("PTY host session limit reached");
    if (this.sessions.has(message.sessionId))
      throw new Error(`PTY session already exists: ${message.sessionId}`);
    const spawnPty = this.options.spawnPty ?? this.loadNativeSpawn();
    const pty = spawnPty(message.executable, [...message.arguments], {
      name: "xterm-256color",
      cols: message.cols,
      rows: message.rows,
      cwd: message.cwd,
      env: Object.fromEntries(
        message.env.map(({ name, value }) => [name, value]),
      ),
      encoding: null,
      ...(this.options.platform === "windows"
        ? { useConpty: true, useConptyDll: true }
        : {}),
    });
    pty.pause();
    const scope = (this.options.createScope ?? ((pid) =>
      createPtyProcessScope(pid, this.options.hostRuntime)))(pty.pid);
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const session: HostSession = {
      sessionId: message.sessionId,
      pty,
      scope,
      commandSeq: 0n,
      outputSeq: 0n,
      pendingOutput: [],
      pendingOutputBytes: 0,
      flushTimer: null,
      pausedForPressure: false,
      pressureRetryScheduled: false,
      exited: null,
      exitDeadline: null,
      closeReason: "natural",
      exitPromise,
      resolveExit,
      dataDisposable: { dispose: () => undefined },
      exitDisposable: { dispose: () => undefined },
    };
    const dataDisposable = pty.onData((data) =>
      this.publishOutput(message.sessionId, data),
    );
    const exitDisposable = pty.onExit(({ exitCode, signal }) => {
      this.handleExit(message.sessionId, exitCode, signal ?? null);
    });
    Object.assign(session, { dataDisposable, exitDisposable });

    try {
      const established = await scope.establish();
      this.options.publish({
        contractVersion: 1,
        kind: "containment",
        sessionId: message.sessionId,
        hostGeneration: message.hostGeneration,
        established,
        mechanism: scope.mechanism,
        processGroupId: scope.processGroupId,
      });
      if (!established) {
        session.closeReason = "containment-failure";
        dataDisposable.dispose();
        exitDisposable.dispose();
        await this.terminateUnstartedPty(pty, scope);
        this.options.publish({
          contractVersion: 1,
          kind: "failure",
          hostGeneration: message.hostGeneration,
          boundary: "containment",
          recoverable: false,
          code: "CONTAINMENT_FAILED",
        });
        return;
      }
      this.sessions.set(message.sessionId, session);
      this.options.publish({
        contractVersion: 1,
        kind: "running",
        sessionId: message.sessionId,
        hostGeneration: message.hostGeneration,
        rootPid: pty.pid,
        processGroupId: scope.processGroupId,
        containment: scope.mechanism,
      });
      pty.resume();
    } catch (error) {
      this.sessions.delete(message.sessionId);
      dataDisposable.dispose();
      exitDisposable.dispose();
      await this.terminateUnstartedPty(pty, scope);
      throw error;
    }
  }

  private applyCommand(
    message: Extract<
      PtyHostServerMessage,
      { kind: "command.input" | "command.resize" }
    >,
  ): void {
    const session = this.requireSession(message.sessionId);
    // The PTY is dead and only its exit event is pending; writing would throw and kill the host.
    if (session.exited) return;
    const sequence = BigInt(message.commandSeq);
    if (sequence !== session.commandSeq + 1n)
      throw new Error("PTY command sequence is out of order");
    if (message.kind === "command.input") {
      session.pty.write(NodeBuffer.Buffer.from(message.dataBase64, "base64"));
    } else {
      session.pty.resize(message.cols, message.rows);
    }
    session.commandSeq = sequence;
    this.options.publish({
      contractVersion: 1,
      kind: "commandAck",
      sessionId: message.sessionId,
      hostGeneration: message.hostGeneration,
      attachmentEpoch: message.attachmentEpoch,
      appliedCommandSeq: message.commandSeq,
      appliedOutputSeq: session.outputSeq.toString(),
    });
  }

  private publishOutput(sessionId: string, data: string | NodeBuffer.Buffer): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const bytes = NodeBuffer.Buffer.isBuffer(data) ? data : NodeBuffer.Buffer.from(data, "utf8");
    if (bytes.length === 0) return;
    session.pendingOutput.push(bytes);
    session.pendingOutputBytes += bytes.length;
    if (session.pendingOutputBytes > SESSION_MAX_PENDING_OUTPUT_BYTES) {
      // The exit reports "natural" because the protocol has no flood-kill reason; bytes dropped here were never sequenced.
      session.pendingOutput = [];
      session.pendingOutputBytes = 0;
      session.pty.kill();
      return;
    }
    if (session.pendingOutputBytes >= PTY_HOST_MAX_DATA_BYTES) this.flushOutput(session);
    this.scheduleFlush(session);
  }

  private scheduleFlush(session: HostSession): void {
    if (
      session.flushTimer !== null ||
      session.pressureRetryScheduled ||
      session.pendingOutputBytes === 0
    ) return;
    session.flushTimer = setTimeout(() => {
      session.flushTimer = null;
      if (this.sessions.get(session.sessionId) === session) this.flushOutput(session);
      if (session.pendingOutputBytes > 0) this.scheduleFlush(session);
    }, OUTPUT_FLUSH_DELAY_MS);
  }

  /** Emits pending output as ≤64 KiB events, applying PTY backpressure while IPC is saturated. */
  private flushOutput(session: HostSession): void {
    if (session.pendingOutputBytes === 0) {
      this.maybePublishExit(session);
      return;
    }
    if (this.isPressured()) {
      this.applyPressure(session);
      return;
    }
    const data = session.pendingOutput.length === 1
      ? session.pendingOutput[0]!
      : NodeBuffer.Buffer.concat(session.pendingOutput, session.pendingOutputBytes);
    session.pendingOutput = [];
    session.pendingOutputBytes = 0;
    this.emitChunks(session, data);
  }

  private emitChunks(session: HostSession, data: NodeBuffer.Buffer): void {
    for (let offset = 0; offset < data.length; offset += PTY_HOST_MAX_DATA_BYTES) {
      if (this.isPressured()) {
        // publish is synchronous, so the re-stashed remainder cannot be reentered mid-loop.
        session.pendingOutput = [data.subarray(offset)];
        session.pendingOutputBytes = data.length - offset;
        this.applyPressure(session);
        return;
      }
      const chunk = data.subarray(offset, offset + PTY_HOST_MAX_DATA_BYTES);
      if (chunk.length === 0) continue;
      session.outputSeq += 1n;
      this.options.publish({
        contractVersion: 1,
        kind: "output",
        sessionId: session.sessionId,
        hostGeneration: this.requireGeneration(),
        outputSeq: session.outputSeq.toString(),
        dataBase64: chunk.toString("base64"),
      });
    }
    this.maybePublishExit(session);
  }

  private isPressured(): boolean {
    return (this.options.queueBytes?.() ?? 0) > OUTPUT_PAUSE_QUEUE_BYTES;
  }

  /** Pauses PTY reads and retries the flush once outbound IPC drains below the resume level. */
  private applyPressure(session: HostSession): void {
    if (!session.pausedForPressure) {
      session.pausedForPressure = true;
      session.pty.pause();
    }
    if (session.pressureRetryScheduled) return;
    session.pressureRetryScheduled = true;
    setTimeout(() => {
      session.pressureRetryScheduled = false;
      if (this.sessions.get(session.sessionId) !== session) return;
      if ((this.options.queueBytes?.() ?? 0) > OUTPUT_RESUME_QUEUE_BYTES) {
        this.applyPressure(session);
        return;
      }
      session.pausedForPressure = false;
      session.pty.resume();
      this.flushOutput(session);
      if (session.pendingOutputBytes > 0) this.scheduleFlush(session);
    }, OUTPUT_FLUSH_DELAY_MS);
  }

  private maybePublishExit(session: HostSession): void {
    if (!session.exited || session.pendingOutputBytes > 0) return;
    if (session.exitDeadline !== null) {
      clearTimeout(session.exitDeadline);
      session.exitDeadline = null;
    }
    this.options.publish({
      contractVersion: 1,
      kind: "exit",
      sessionId: session.sessionId,
      hostGeneration: this.requireGeneration(),
      finalOutputSeq: session.outputSeq.toString(),
      code: session.exited.code,
      signal: session.exited.signal,
      reason: session.closeReason,
    });
    this.sessions.delete(session.sessionId);
    session.resolveExit();
    session.scope.dispose();
  }

  private async closeSession(
    sessionId: string,
    reason: HostSession["closeReason"],
    closeSeq?: string,
    graceful = false,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    // The PTY already exited; only its pending exit event remains. Commands can no longer
    // be applied, so closeSeq enforcement would reject a legitimate close and kill the host.
    if (session.exited) {
      await session.exitPromise;
      return;
    }
    if (
      closeSeq !== undefined &&
      BigInt(closeSeq) !== session.commandSeq + 1n
    ) {
      throw new Error("PTY close sequence is out of order");
    }
    session.closeReason = reason;
    await session.scope.close(graceful);
    await session.exitPromise;
  }

  private handleExit(
    sessionId: string,
    code: number,
    signal: number | null,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.dataDisposable.dispose();
    session.exitDisposable.dispose();
    session.exited = { code, signal };
    // Scope stays alive while the exit event waits behind pending output; the deadline
    // bounds that wait so a stalled IPC queue cannot wedge the serial close path.
    this.flushOutput(session);
    if (session.pendingOutputBytes > 0 && session.exitDeadline === null) {
      session.exitDeadline = setTimeout(() => {
        session.exitDeadline = null;
        session.pendingOutput = [];
        session.pendingOutputBytes = 0;
        this.maybePublishExit(session);
      }, EXIT_OUTPUT_DEADLINE_MS);
    }
  }

  private publishHeartbeat(): void {
    this.options.publish({
      contractVersion: 1,
      kind: "heartbeat",
      hostGeneration: this.requireGeneration(),
      monotonicMs: Math.floor(performance.now()).toString(),
      activeSessions: this.sessions.size,
      queueBytes: this.options.queueBytes?.() ?? 0,
      rssBytes: process.memoryUsage().rss.toString(),
    });
  }

  private requireSession(sessionId: string): HostSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`PTY session not found: ${sessionId}`);
    return session;
  }

  private async terminateUnstartedPty(
    pty: IPty,
    scope: PtyProcessScope,
  ): Promise<void> {
    try {
      await scope.close();
    } catch {
      pty.kill();
    } finally {
      scope.dispose();
    }
  }

  private requireGeneration(): string {
    if (this.generation === null)
      throw new Error("PTY host handshake is incomplete");
    return this.generation;
  }

  private loadNativeSpawn(): typeof import("node-pty").spawn {
    return (nativeRequire("node-pty") as typeof import("node-pty")).spawn;
  }
}
