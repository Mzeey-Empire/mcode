/**
 * Legacy PTY (pseudo-terminal) management service.
 * Spawns and manages terminal sessions tied to threads.
 * Extracted from apps/desktop/src/main/pty-manager.ts.
 */

import { injectable, inject } from "tsyringe";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import { v4 as uuid } from "uuid";
import { logger } from "@mcode/shared";
import { TERMINAL_MAX_PER_SCOPE, type LegacyTerminalRecord, type LegacyTerminalCreateResult, type Settings, type TerminalProfileReference, type TerminalResolvedProfile, type TerminalScope, type WorkspaceEnvironmentActionLaunchSnapshot } from "@mcode/contracts";
import { TerminalFlowControl } from "./terminal-flow-control.js";
import { TerminalReplayBuffer, replayCapBytesForScrollback } from "./terminal-replay-buffer.js";
import type { PtyHostAdapter, PtyHostCommand } from "../../host/pty-host-adapter.js";
import type { PtyHostEvent } from "../../host/pty-host-protocol.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import type { WorkspaceRepo } from "../../../projects/persistence/workspace-repo.js";
import { GitWorktreeService } from "../../../projects/git/git-worktree-service.js";
import type { SettingsService } from "../../../settings/settings-service.js";
import { EnvService } from "../../../../runtime/environment/env-service.js";
import { ActionTerminalClosedError, TerminalCapacityError, type ActionTerminal, type ActionTerminalRequest, type PreparedActionLaunch } from "../terminal-backend.js";
import { ActionTerminalEvents, actionCommandEcho } from "./action-terminal-events.js";

/** Resolved host launch shared by command and interactive shell phases. */
export interface LegacyTerminalLaunch {
  readonly executable: string;
  readonly arguments: string[];
  readonly requestedProfileId: TerminalProfileReference;
  readonly resolvedProfile: TerminalResolvedProfile;
  readonly environment?: Record<string, string>;
}

interface PtyProcess {
  readonly id: string;
  readonly hostGeneration: string;
  readonly outputOffset: number;
  status: "creating" | "running";
  creation: Promise<boolean>;
  commandSequence: bigint;
  commandTail: Promise<void>;
  readonly exited: Promise<void>;
  resolveExit(): void;
  afterExit: "shell" | "retain" | "replace";
}

type TerminalPhase =
  | { readonly kind: "pending" }
  | { readonly kind: "command" | "shell"; readonly process: PtyProcess }
  | { readonly kind: "exited"; readonly exitCode: number | null };

interface ActionState {
  readonly actionId: string;
  readonly shellLaunch: LegacyTerminalLaunch;
  readonly events: ActionTerminalEvents;
}

interface PtySession {
  readonly id: string;
  readonly threadId: string;
  readonly shell: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly action: ActionState | null;
  phase: TerminalPhase;
  sequence: number;
  cols: number;
  rows: number;
  transition: Promise<void>;
  operation: Promise<void>;
  closePromise: Promise<void> | null;
}

/** Callbacks for streaming PTY output and exit events to connected clients. */
export interface PtySender {
  json: (channel: string, data: Record<string, unknown>) => void;
  data: (ptyId: string, seq: number, bytes: Uint8Array) => void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_HOST_ENVIRONMENT_NAMES = 256;
const MAX_HOST_ENVIRONMENT_BYTES = 65_536;

function shellBasename(shellPath: string): string {
  return (shellPath.split(/[\\/]/).pop() ?? shellPath).replace(/\.exe$/i, "").slice(0, 64);
}

function currentProcess(session: PtySession): PtyProcess | null {
  return session.phase.kind === "command" || session.phase.kind === "shell" ? session.phase.process : null;
}

/** Owns retained terminal records and routes each phase's host session to its stable web id. */
@injectable()
export class TerminalService {
  private readonly sessions = new Map<string, PtySession>();
  private readonly hostSessions = new Map<string, PtySession>();
  private readonly threadIndex = new Map<string, Set<string>>();
  private sender: PtySender | null = null;
  private readonly flowControls = new Map<string, TerminalFlowControl>();
  private readonly replayBuffers = new Map<string, TerminalReplayBuffer>();
  private lastScrollback: number;
  private readonly unsubscribeSettings: () => void;
  private readonly unsubscribeHost: () => void;
  private useGracefulKill = false;

  constructor(
    @inject("ThreadRepo") private readonly threadRepo: ThreadRepo,
    @inject("WorkspaceRepo") private readonly workspaceRepo: WorkspaceRepo,
    @inject(GitWorktreeService) private readonly gitWorktrees: GitWorktreeService,
    @inject("SettingsService") private readonly settingsService: SettingsService,
    @inject(EnvService) private readonly envService: EnvService,
    @inject("PtyHost") private readonly host: PtyHostAdapter,
  ) {
    // Keep server-side scrollback retention in sync with the terminal.scrollback
    // setting: when the user changes it, resize all live replay buffers so
    // running sessions honour the new retention window.
    this.lastScrollback = this.settingsService.get().terminal.behavior.scrollback;
    this.unsubscribeSettings = this.settingsService.on("change", (next) => {
      this.applyScrollbackToReplayBuffers(next.terminal.behavior.scrollback);
    });
    this.unsubscribeHost = this.host.subscribe((event) => this.handleHostEvent(event));
  }

  /**
   * Resize all live replay buffers to match a new terminal.scrollback value.
   * No-op when the value is unchanged so unrelated settings edits are cheap.
   */
  private applyScrollbackToReplayBuffers(scrollback: number): void {
    if (scrollback === this.lastScrollback) return;
    this.lastScrollback = scrollback;
    const cap = replayCapBytesForScrollback(scrollback);
    for (const buffer of this.replayBuffers.values()) {
      buffer.setCap(cap);
    }
  }

  /** Set the sender used to stream PTY data to connected clients. */
  setSender(sender: PtySender): void {
    this.sender = sender;
  }

  /** Creates an ordinary shell terminal, retaining its record after exit. */
  async create(scopeId: string, launch: LegacyTerminalLaunch, replacesPtyId?: string): Promise<LegacyTerminalCreateResult> {
    const session = this.reserveTerminal(scopeId, launch, null, replacesPtyId);
    try {
      await this.launchProcess(session, "shell", launch, session.id);
      return { ...this.sessionRecord(session), shell: shellBasename(session.shell) };
    } catch (error) {
      this.removePty(session.id);
      throw error;
    }
  }

  private reserveTerminal(
    scopeId: string,
    launch: LegacyTerminalLaunch,
    action: ActionState | null,
    replacesPtyId?: string,
  ): PtySession {
    const cwd = this.resolveWorkingDirectory(scopeId);
    if (!NodePath.isAbsolute(cwd) || !NodeFS.existsSync(cwd) || !NodeFS.statSync(cwd).isDirectory()) {
      throw new Error(`Invalid working directory: ${cwd}`);
    }
    const createdAt = this.removeExitedReplacement(scopeId, replacesPtyId);
    this.assertCapacity(scopeId, action !== null);
    const session: PtySession = {
      id: uuid(), threadId: scopeId, shell: launch.executable, cwd,
      createdAt: createdAt ?? new Date().toISOString(), action, phase: { kind: "pending" },
      sequence: 0, cols: DEFAULT_COLS, rows: DEFAULT_ROWS,
      transition: Promise.resolve(), operation: Promise.resolve(), closePromise: null,
    };
    this.sessions.set(session.id, session);
    const index = this.threadIndex.get(scopeId) ?? new Set<string>();
    index.add(session.id);
    this.threadIndex.set(scopeId, index);
    this.flowControls.set(session.id, this.createFlowControl(session.id, this.settingsService.get().terminal));
    this.replayBuffers.set(session.id, new TerminalReplayBuffer(replayCapBytesForScrollback(this.lastScrollback)));
    return session;
  }

  private assertCapacity(scopeId: string, action: boolean): void {
    if ((this.threadIndex.get(scopeId)?.size ?? 0) >= TERMINAL_MAX_PER_SCOPE) {
      throw new TerminalCapacityError(`Maximum PTY limit (${TERMINAL_MAX_PER_SCOPE}) reached for scope ${scopeId}`);
    }
    if (action && this.sessions.size >= this.settingsService.get().terminal.behavior.sessionLimit) {
      throw new Error("The app-wide Terminal session limit is reached");
    }
  }

  private removeExitedReplacement(scopeId: string, replacesPtyId?: string): string | undefined {
    const session = replacesPtyId === undefined ? undefined : this.sessions.get(replacesPtyId);
    if (!session || session.threadId !== scopeId || session.action || session.phase.kind !== "exited") return undefined;
    this.removePty(session.id);
    return session.createdAt;
  }

  private createFlowControl(id: string, settings: Settings["terminal"]): TerminalFlowControl {
    const flowControl = new TerminalFlowControl({
      sink: (sequence, bytes) => this.sender?.data(id, sequence, bytes),
      highBytes: settings.flowControl.serverHighBytes,
      lowBytes: settings.flowControl.serverLowBytes,
    });
    flowControl.pause("client-request");
    return flowControl;
  }

  private async launchProcess(
    session: PtySession, kind: "command" | "shell", launch: LegacyTerminalLaunch, hostId = uuid(),
  ): Promise<void> {
    const { hostGeneration } = await this.host.start();
    this.assertOpen(session);
    let resolveExit = (): void => {};
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const process: PtyProcess = {
      id: hostId, hostGeneration, outputOffset: session.sequence, status: "creating",
      creation: Promise.resolve(false), commandSequence: 0n, commandTail: Promise.resolve(),
      exited, resolveExit, afterExit: kind === "command" ? "shell" : "retain",
    };
    session.phase = { kind, process };
    this.hostSessions.set(hostId, session);
    const creation = this.createHostProcess(session, process, launch);
    process.creation = creation.then(() => true, () => false);
    try {
      await creation;
      process.status = "running";
    } catch (error) {
      this.hostSessions.delete(hostId);
      if (currentProcess(session) === process) {
        session.phase = { kind: "exited", exitCode: null };
      }
      resolveExit();
      this.assertOpen(session);
      throw error;
    }
  }

  private async createHostProcess(session: PtySession, process: PtyProcess, launch: LegacyTerminalLaunch): Promise<void> {
    await this.host.create({
      sessionId: process.id, hostGeneration: process.hostGeneration,
      launch: {
        requestedProfileId: launch.requestedProfileId, resolvedProfile: launch.resolvedProfile,
        scope: this.scopeFor(session.threadId), arguments: launch.arguments,
      },
      cwd: session.cwd,
      protectedEnv: this.environmentSnapshot(launch.environment ?? this.envService.getEnv()),
      cols: session.cols, rows: session.rows,
    });
  }

  private assertOpen(session: PtySession): void {
    if (!this.sessions.has(session.id) || session.closePromise) throw new ActionTerminalClosedError("Terminal scope was closed");
  }

  /** Resolves the checkout path used by a thread or workspace terminal session. */
  resolveWorkingDirectory(scopeId: string): string {
    const thread = this.threadRepo.findById(scopeId);
    if (thread) {
      const workspace = this.workspaceRepo.findById(thread.workspace_id);
      if (!workspace) throw new Error(`Workspace not found: ${thread.workspace_id}`);
      return this.gitWorktrees.resolveWorkingDir(workspace.path, thread.mode, thread.worktree_path);
    }
    const workspace = this.workspaceRepo.findById(scopeId);
    if (!workspace) throw new Error(`Thread or workspace not found: ${scopeId}`);
    return workspace.path;
  }

  private scopeFor(scopeId: string): TerminalScope {
    const thread = this.threadRepo.findById(scopeId);
    if (thread) return { kind: "thread", workspaceId: thread.workspace_id, threadId: thread.id };
    return { kind: "workspace", workspaceId: scopeId };
  }

  private environmentSnapshot(environment: Record<string, string>): Array<{ name: string; value: string }> {
    const entries = Object.entries(environment)
      .filter(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) && typeof value === "string")
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length > MAX_HOST_ENVIRONMENT_NAMES) {
      throw new Error("Terminal environment exceeds the host boundary limit");
    }
    for (const [, value] of entries) {
      if (value.length > 8_192) {
        throw new Error("Terminal environment contains an invalid entry");
      }
    }
    const snapshot = entries.map(([name, value]) => ({ name, value }));
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_HOST_ENVIRONMENT_BYTES) {
      throw new Error("Terminal environment exceeds the host boundary limit");
    }
    return snapshot;
  }

  /** Opens one attachable action record and starts its command when approval is present. */
  async openActionTerminal(
    input: ActionTerminalRequest,
    shellLaunch: LegacyTerminalLaunch,
    prepare: (launch: PreparedActionLaunch, cwd: string) => Promise<{
      readonly launch: LegacyTerminalLaunch;
      readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
    }>,
  ): Promise<ActionTerminal> {
    const events = new ActionTerminalEvents(replayCapBytesForScrollback(this.lastScrollback));
    const session = this.reserveTerminal(input.threadId, shellLaunch, { actionId: input.actionId, shellLaunch, events });
    let snapshot: WorkspaceEnvironmentActionLaunchSnapshot | null = null;
    const run = (launch: PreparedActionLaunch): Promise<WorkspaceEnvironmentActionLaunchSnapshot> =>
      this.serializeAction(session, async () => {
        snapshot = await this.runAction(session, launch, prepare);
        return snapshot;
      });
    const terminal: ActionTerminal = {
      terminalSessionId: session.id, run,
      get snapshot() { return snapshot; },
      stopCommand: (afterExit) => this.serializeAction(session, () => this.stopActionProcess(session, afterExit === "replace")),
      onCommandOutput: events.onCommandOutput, onCommandExit: events.onCommandExit, onClosed: events.onClosed,
    };
    try {
      if (input.launch !== "pending-approval") await run(input.launch);
      return terminal;
    } catch (error) {
      await this.kill(session.id);
      throw error;
    }
  }

  private serializeAction<T>(session: PtySession, operation: () => Promise<T>): Promise<T> {
    const next = session.operation.then(operation);
    session.operation = next.then(() => undefined, () => undefined);
    return next;
  }

  private async runAction(
    session: PtySession, input: PreparedActionLaunch,
    prepare: (launch: PreparedActionLaunch, cwd: string) => Promise<{
      readonly launch: LegacyTerminalLaunch; readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot;
    }>,
  ): Promise<WorkspaceEnvironmentActionLaunchSnapshot> {
    this.assertOpen(session);
    const prepared = await prepare(input, session.cwd);
    await this.stopActionProcess(session, true);
    await session.transition;
    this.assertOpen(session);
    session.action?.events.reset();
    this.recordOutput(session, ++session.sequence, actionCommandEcho(session.shell, session.cwd, input.script));
    const environment = this.envService.getEnv();
    try {
      await this.launchProcess(session, "command", { ...prepared.launch, environment });
      this.assertOpen(session);
    } catch (error) {
      this.assertOpen(session);
      session.phase = { kind: "exited", exitCode: null };
      this.notifyTerminalExit(session, null);
      throw error;
    }
    return { ...prepared.snapshot, environmentNames: Object.keys(environment).sort() };
  }

  private async stopActionProcess(session: PtySession, replacing = false): Promise<void> {
    await session.transition;
    if (!replacing && session.phase.kind !== "command") return;
    const process = currentProcess(session);
    if (!process) return;
    await process.creation;
    if (currentProcess(session) !== process) return;
    const afterExit = process.afterExit;
    process.afterExit = replacing ? "replace" : "shell";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (session.phase.kind !== "command") {
        await this.closeProcess(session, process, "user");
        return;
      }
      await this.interruptProcess(session, process);
      const exited = await Promise.race([
        process.exited.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
      ]);
      if (!exited) await this.closeProcess(session, process, "user");
      await process.exited;
      await session.transition;
    } finally {
      clearTimeout(timer);
      if (currentProcess(session) === process) process.afterExit = afterExit;
    }
  }

  private async interruptProcess(session: PtySession, process: PtyProcess): Promise<void> {
    try {
      await this.write(session.id, "\u0003");
    } catch {
      await this.closeProcess(session, process, "user");
    }
  }

  private async closeProcess(session: PtySession, process: PtyProcess, reason: "user" | "app-shutdown"): Promise<void> {
    await process.commandTail.catch(() => undefined);
    if (currentProcess(session) !== process) return;
    await this.host.close({
      sessionId: process.id, hostGeneration: process.hostGeneration,
      closeSeq: (process.commandSequence + 1n).toString(), reason,
    });
    // Some adapters acknowledge close without an exit event.
    if (currentProcess(session) === process) this.processExited(session, process, null);
  }

  /**
   * Hold a PTY under the client-request pause source. Idempotent.
   * Throws if the PTY ID is not found.
   */
  pause(ptyId: string): void {
    const fc = this.flowControls.get(ptyId);
    if (this.sessions.get(ptyId)?.phase.kind === "exited") return;
    if (!fc) throw new Error(`PTY not found: ${ptyId}`);
    fc.pause("client-request");
  }

  /**
   * Release the client-request pause source for a PTY. Idempotent.
   * Throws if the PTY ID is not found.
   */
  resume(ptyId: string): void {
    const fc = this.flowControls.get(ptyId);
    if (!fc) throw new Error(`PTY not found: ${ptyId}`);
    fc.release("client-request");
  }

  /**
   * Invoked by the socket coordinator with the current worst-case
   * ws.bufferedAmount across all connected clients.
   */
  onBufferedAmountTick(bufferedAmount: number): void {
    for (const [, fc] of this.flowControls) {
      if (bufferedAmount > fc.marks.high) {
        fc.pause("socket-buffered");
      } else if (bufferedAmount < fc.marks.low) {
        fc.release("socket-buffered");
      }
    }
  }

  /** Writes to the currently attached process, never an earlier phase. */
  write(ptyId: string, data: string): Promise<void> {
    const process = this.requireRunningProcess(ptyId);
    return this.sendCommand(process, (commandSeq) => ({
      sessionId: process.id, hostGeneration: process.hostGeneration, attachmentEpoch: "0",
      commandSeq, kind: "input", data: Buffer.from(data, "utf8"),
    }));
  }

  /** Resizes the current process and retains dimensions for the following phase. */
  resize(ptyId: string, cols: number, rows: number): Promise<void> {
    const process = this.requireRunningProcess(ptyId);
    const session = this.sessions.get(ptyId);
    if (session) { session.cols = cols; session.rows = rows; }
    return this.sendCommand(process, (commandSeq) => ({
      sessionId: process.id, hostGeneration: process.hostGeneration, attachmentEpoch: "0",
      commandSeq, kind: "resize", data: { cols, rows },
    }));
  }

  private requireRunningProcess(ptyId: string): PtyProcess {
    const session = this.sessions.get(ptyId);
    const process = session && currentProcess(session);
    if (!process) throw new Error(`PTY not found: ${ptyId}`);
    if (session.closePromise || process.status !== "running") throw new Error("PTY is not running");
    return process;
  }

  private sendCommand(session: PtyProcess, makeCommand: (commandSeq: string) => PtyHostCommand): Promise<void> {
    const send = async (): Promise<void> => {
      const commandSeq = session.commandSequence + 1n;
      await this.host.send(makeCommand(commandSeq.toString()));
      session.commandSequence = commandSeq;
    };
    session.commandTail = session.commandTail.then(send, send);
    return session.commandTail;
  }

  /** Closes a retained record, interrupting an active command without starting a shell. */
  async kill(
    ptyId: string,
    reason: "user-requested-process-tree-close" | "app-shutdown" = "user-requested-process-tree-close",
  ): Promise<void> {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    if (session.closePromise) return session.closePromise;
    const closing = Promise.resolve().then(async () => {
      await session.transition;
      const process = currentProcess(session);
      if (process) {
        await process.creation;
        process.afterExit = "replace";
        await this.closeProcess(session, process, reason === "app-shutdown" && this.useGracefulKill ? "app-shutdown" : "user");
      }
      this.notifyTerminalExit(session, null);
      this.removePty(ptyId);
    });
    session.closePromise = closing.catch((error: unknown) => {
      session.closePromise = null;
      const process = currentProcess(session);
      if (process) process.afterExit = session.phase.kind === "command" ? "shell" : "retain";
      throw error;
    });
    return session.closePromise;
  }

  /** Closes visible shells, including hidden action terminals only for scope teardown. */
  async killByThread(threadId: string, includeActions = false): Promise<void> {
    const ids = [...(this.threadIndex.get(threadId) ?? [])]
      .filter((id) => includeActions || !this.sessions.get(id)?.action);
    await Promise.all(ids.map((id) => this.kill(id)));
  }

  /** Stops the host after in-flight creations and commands settle. */
  async shutdown(): Promise<void> {
    this.unsubscribeSettings();
    this.unsubscribeHost();
    const sessions = [...this.sessions.values()];
    await Promise.allSettled(sessions.map(async (session) => {
      await session.transition;
      const process = currentProcess(session);
      await process?.creation;
      await process?.commandTail;
    }));
    await this.host.shutdown();
    for (const session of sessions) this.removePty(session.id);
  }

  /**
   * Enable or disable graceful signal ladder (SIGHUP → SIGTERM → SIGKILL) for
   * the next destroyPty calls. Call with `true` just before app-quit shutdown.
   * User-initiated kills remain force-immediate regardless of this flag.
   */
  setGracefulKill(enabled: boolean): void {
    this.useGracefulKill = enabled;
  }

  /**
   * Replay buffered PTY output to a reconnecting client.
   * Sends chunks with seq > lastSeq as binary frames through the normal sender
   * path, then returns whether the replay window was exceeded.
   *
   * @param ptyId - The PTY session to replay.
   * @param lastSeq - Last seq number the client received before the disconnect.
   */
  reattach(
    ptyId: string,
    lastSeq: number,
    cold = false,
  ):
    | { mode: "delta" }
    | { mode: "reset"; discardThrough: number }
    | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number } {
    const replayBuffer = this.replayBuffers.get(ptyId);
    if (!replayBuffer) throw new Error(`PTY not found: ${ptyId}`);
    const replay = this.prepareReattachReplay(replayBuffer, lastSeq, cold);
    this.sendReattachReplay(ptyId, replay.chunks, replay.gapped);
    return this.reattachResult(replayBuffer, replay.restore, replay.gapped);
  }

  private prepareReattachReplay(
    replayBuffer: TerminalReplayBuffer,
    lastSeq: number,
    cold: boolean,
  ): {
    readonly chunks: ReturnType<TerminalReplayBuffer["replay"]>["chunks"];
    readonly gapped: boolean;
    readonly restore: ReturnType<TerminalReplayBuffer["restoreCold"]> | null;
  } {
    const restore = cold ? replayBuffer.restoreCold() : null;
    if (restore) {
      return { chunks: restore.chunks, gapped: restore.mode === "reset", restore };
    }
    const replay = replayBuffer.replay(lastSeq);
    return { ...replay, restore: null };
  }

  private sendReattachReplay(
    ptyId: string,
    chunks: ReturnType<TerminalReplayBuffer["replay"]>["chunks"],
    gapped: boolean,
  ): void {
    const sender = this.sender;
    if (!sender || gapped) return;
    for (const { seq, bytes } of chunks) sender.data(ptyId, seq, bytes);
  }

  private reattachResult(
    replayBuffer: TerminalReplayBuffer,
    restore: ReturnType<TerminalReplayBuffer["restoreCold"]> | null,
    gapped: boolean,
  ):
    | { mode: "delta" }
    | { mode: "reset"; discardThrough: number }
    | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number } {
    if (restore?.mode === "checkpoint") {
      return {
        mode: "checkpoint",
        checkpoint: restore.checkpoint.data,
        checkpointThrough: restore.checkpoint.seq,
      };
    }
    if (restore?.mode === "reset") return { mode: "reset", discardThrough: restore.discardThrough };
    if (gapped) return { mode: "reset", discardThrough: replayBuffer.latest };
    return { mode: "delta" };
  }

  /** Saves a bounded serialized renderer state for a later cold mount. */
  checkpoint(ptyId: string, seq: number, data: string): { accepted: boolean } {
    const replayBuffer = this.replayBuffers.get(ptyId);
    if (!replayBuffer) throw new Error(`PTY not found: ${ptyId}`);
    return { accepted: replayBuffer.checkpointAt(seq, data) };
  }

  /** Lists all retained records, including pending approval and exited terminals. */
  listActiveSessions(): LegacyTerminalRecord[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((session) => this.sessionRecord(session));
  }

  private sessionRecord(session: PtySession): LegacyTerminalRecord {
    const phase = session.phase;
    return {
      ptyId: session.id, threadId: session.threadId, shell: shellBasename(session.shell), cwd: session.cwd,
      kind: session.action ? "action" : "shell",
      ...(session.action ? { actionId: session.action.actionId } : {}),
      state: this.recordState(phase),
      exitCode: phase.kind === "exited" ? phase.exitCode : null, createdAt: session.createdAt,
    };
  }

  private recordState(phase: TerminalPhase): "pending" | "running" | "exited" {
    if (phase.kind === "exited") return "exited";
    if (phase.kind === "pending" || phase.process.status === "creating") return "pending";
    return "running";
  }

  /** Reports children of the current phase's process. */
  async hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error(`PTY not found: ${ptyId}`);
    const process = currentProcess(session);
    return process ? this.host.inspectChildren(process.id, process.hostGeneration) : { hasChildren: false };
  }

  private handleHostEvent(event: PtyHostEvent): void {
    if (event.kind === "output") this.handleHostOutput(event);
    if (event.kind === "exit") this.handleHostExit(event);
    if (event.kind === "failure") this.handleHostFailure(event);
  }

  private handleHostOutput(event: Extract<PtyHostEvent, { kind: "output" }>): void {
    const session = this.hostSessions.get(event.sessionId);
    const process = session && currentProcess(session);
    if (!session || !process || process.hostGeneration !== event.hostGeneration) return;
    const bytes = Buffer.from(event.dataBase64, "base64");
    const sequence = process.outputOffset + Number(event.outputSeq);
    if (sequence <= session.sequence) return;
    session.sequence = sequence;
    this.recordOutput(session, sequence, bytes);
    if (session.phase.kind === "command") session.action?.events.emitOutput(bytes);
  }

  private recordOutput(session: PtySession, sequence: number, bytes: Uint8Array): void {
    this.replayBuffers.get(session.id)?.record(sequence, bytes);
    this.flowControls.get(session.id)?.push(sequence, bytes);
  }

  private handleHostExit(event: Extract<PtyHostEvent, { kind: "exit" }>): void {
    const session = this.hostSessions.get(event.sessionId);
    const process = session && currentProcess(session);
    if (session && process?.hostGeneration === event.hostGeneration) this.processExited(session, process, event.code);
  }

  private handleHostFailure(event: Extract<PtyHostEvent, { kind: "failure" }>): void {
    for (const session of this.sessions.values()) {
      const process = currentProcess(session);
      if (!process || process.hostGeneration !== event.hostGeneration) continue;
      process.afterExit = "retain";
      this.processExited(session, process, 1);
    }
  }

  private processExited(session: PtySession, process: PtyProcess, exitCode: number | null): void {
    const wasCommand = session.phase.kind === "command";
    this.hostSessions.delete(process.id);
    session.phase = { kind: "exited", exitCode };
    if (wasCommand) session.action?.events.emitExit(session.closePromise ? 130 : exitCode);
    if (process.afterExit === "shell" && !session.closePromise && session.action) {
      session.transition = this.launchFollowingShell(session, session.action.shellLaunch);
    } else if (process.afterExit === "retain") {
      this.notifyTerminalExit(session, exitCode);
    }
    process.resolveExit();
  }

  private async launchFollowingShell(session: PtySession, launch: LegacyTerminalLaunch): Promise<void> {
    try {
      await this.launchProcess(session, "shell", launch);
    } catch (error) {
      if (session.closePromise || !this.sessions.has(session.id)) return;
      logger.warn("Action terminal shell launch failed", { id: session.id, error: String(error) });
      session.phase = { kind: "exited", exitCode: null };
      this.notifyTerminalExit(session, null);
    }
  }

  private notifyTerminalExit(session: PtySession, exitCode: number | null): void {
    this.flowControls.get(session.id)?.resume();
    this.sender?.json("terminal.exit", {
      ptyId: session.id, code: exitCode ?? 0, ...(exitCode === null ? { exitCode: null } : {}),
    });
  }

  private removePty(ptyId: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    this.sessions.delete(ptyId);
    const process = currentProcess(session);
    if (process) this.hostSessions.delete(process.id);
    const index = this.threadIndex.get(session.threadId);
    index?.delete(ptyId);
    if (index?.size === 0) this.threadIndex.delete(session.threadId);
    this.flowControls.delete(ptyId);
    this.replayBuffers.delete(ptyId);
    session.action?.events.close();
  }
}
