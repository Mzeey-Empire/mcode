import {
  LegacyTerminalRecordSchema,
  WS_METHODS,
  type LegacyTerminalCreateResult,
  TerminalDiagnosticsBundleSchema,
  type TerminalDiagnosticsBundle,
} from "@mcode/contracts";
import { withTerminalTimeout } from "../terminal-client";
import type {
  TerminalClient,
  TerminalCheckpoint,
  TerminalClientSubscription,
  TerminalClientReattachResult,
  TerminalRpcCall,
  TerminalActiveSession,
} from "../terminal-client";
import {
  emitPtyReconnectGap,
  onPtyData,
  onPtyExit,
  onPtyReconnectGap,
} from "../pty-data-registry";

/** Validates and adapts version 0 Terminal RPCs to the client transport seam. */
export class LegacyTerminalClient implements TerminalClient {
  constructor(private readonly rpc: TerminalRpcCall) {}

  /** Creates one legacy PTY. */
  async create(threadId: string, replacesSessionId?: string): Promise<LegacyTerminalCreateResult> {
    if (replacesSessionId) await this.kill(replacesSessionId);
    return WS_METHODS()["terminal.create"].result.parse(await this.rpc("terminal.create", { threadId }));
  }

  /** Writes input to one legacy PTY. */
  async write(ptyId: string, data: string): Promise<void> {
    await this.rpc("terminal.write", { ptyId, data });
  }

  /** Resizes one legacy PTY. */
  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.rpc("terminal.resize", { ptyId, cols, rows });
  }

  /** Closes one legacy PTY. */
  async kill(ptyId: string): Promise<void> {
    await this.rpc("terminal.kill", { ptyId });
  }

  /** Pauses output from one legacy PTY. */
  async pause(ptyId: string): Promise<void> {
    await this.rpc("terminal.pause", { ptyId });
  }

  /** Resumes output from one legacy PTY. */
  async resume(ptyId: string): Promise<void> {
    await this.rpc("terminal.resume", { ptyId });
  }

  /** Detaches the legacy renderer through its compatibility RPC. */
  async detachForSwitch(
    ptyId: string,
    checkpoint?: Promise<TerminalCheckpoint | undefined>,
  ): Promise<void> {
    const state = checkpoint
      ? await withTerminalTimeout(checkpoint).catch(() => undefined)
      : undefined;
    await withTerminalTimeout(
      (state ? this.checkpoint(ptyId, state.seq, state.data) : Promise.resolve())
        .catch(() => undefined)
        .then(() => this.pause(ptyId)),
    );
  }

  /** Bridges legacy global push events during the compatibility window. */
  subscribe(ptyId: string, subscription: TerminalClientSubscription): () => void {
    const unsubs = [
      subscription.onData ? onPtyData(ptyId, subscription.onData) : undefined,
      subscription.onExit
        ? onPtyExit(ptyId, (detail) => subscription.onExit?.({
            ptyId: detail.ptyId,
            code: detail.code,
            state: "exited",
            exit: { code: detail.exitCode === undefined ? detail.code : detail.exitCode, signal: null, reason: "natural" },
          }))
        : undefined,
      subscription.onReconnectGap
        ? onPtyReconnectGap(ptyId, () => subscription.onReconnectGap?.())
        : undefined,
    ].filter((unsubscribe): unsubscribe is () => void => Boolean(unsubscribe));
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }

  /** Delivers a reconnect gap through the legacy compatibility registry. */
  notifyReconnectGap(ptyId: string): void {
    emitPtyReconnectGap({ ptyId });
  }

  /** Closes all legacy PTYs for one scope. */
  async killByThread(threadId: string): Promise<void> {
    await this.rpc("terminal.killByThread", { threadId });
  }

  /** Reattaches to one legacy PTY and restores retained output. */
  async reattach(
    ptyId: string,
    lastSeq: number,
    cold?: boolean,
  ): Promise<TerminalClientReattachResult> {
    return WS_METHODS()["terminal.reattach"].result.parse(await this.rpc("terminal.reattach", { ptyId, lastSeq, cold }));
  }

  /** Stores one bounded legacy renderer checkpoint. */
  async checkpoint(ptyId: string, seq: number, data: string): Promise<{ accepted: boolean }> {
    return WS_METHODS()["terminal.checkpoint"].result.parse(await withTerminalTimeout(this.rpc("terminal.checkpoint", { ptyId, seq, data })));
  }

  /** Lists all active legacy PTYs. */
  async listActive(): Promise<TerminalActiveSession[]> {
    const sessions = LegacyTerminalRecordSchema().array().parse(await this.rpc("terminal.listActive", {}));
    return sessions.map((session) => ({ ...session, state: session.state ?? "running" }));
  }

  /** Reports whether one legacy PTY owns child processes. */
  async hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return WS_METHODS()["terminal.hasChildren"].result.parse(await this.rpc("terminal.hasChildren", { ptyId }));
  }

  /** Fetches and validates the content-free diagnostics bundle at the legacy boundary. */
  async diagnostics(): Promise<TerminalDiagnosticsBundle> {
    return TerminalDiagnosticsBundleSchema().parse(
      await this.rpc("terminal.diagnostics.getBundle", {}),
    );
  }
}
