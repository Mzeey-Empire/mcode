import { inject, injectable } from "tsyringe";
import type { LegacyTerminalRecord, LegacyTerminalCreateResult, TerminalBackendCapabilities } from "@mcode/contracts";
import type { HostRuntime } from "@mcode/shared/node/host-runtime";
import {
  TerminalBackend,
  PreparedTerminalCommandApprovalMismatchError,
  type TerminalBackendSender,
  type ActionTerminalRequest,
  type ActionTerminal,
  type PreparedActionLaunch,
  type TerminalReattachResult,
} from "../terminal-backend.js";
import { TerminalService } from "./terminal-service.js";
import type { ThreadRepo } from "../../../thread-control/persistence/thread-repo.js";
import { TerminalProfileService } from "../../profiles/terminal-profile-service.js";
import { noninteractiveLaunch } from "../../commands/terminal-command-service.js";
import { terminalPlatform } from "../../terminal-platform.js";

const LEGACY_CAPABILITIES = Object.freeze({
  contractVersion: 0,
  backend: "legacy",
  publicFrameVersion: 0,
  recovery: Object.freeze({ replay: true, checkpoint: true, gap: true }),
} as const satisfies TerminalBackendCapabilities);

/** Adapts the frozen version 0 Terminal service to the boot-selected backend seam. */
@injectable()
export class LegacyTerminalBackend extends TerminalBackend {
  constructor(
    private readonly terminalService: TerminalService,
    @inject("ThreadRepo") private readonly threads: ThreadRepo,
    @inject(TerminalProfileService) private readonly profiles: TerminalProfileService,
    @inject("HostRuntime") private readonly hostRuntime: HostRuntime,
  ) {
    super();
  }

  /** Reports the selected legacy protocol and its recovery features. */
  capabilities(): TerminalBackendCapabilities {
    return LEGACY_CAPABILITIES;
  }

  /** Installs the output sender used by the legacy service. */
  setSender(sender: TerminalBackendSender): void {
    this.terminalService.setSender(sender);
  }

  /** Creates one legacy PTY for a thread or workspace scope. */
  async create(scopeId: string, replacesPtyId?: string): Promise<LegacyTerminalCreateResult> {
    const thread = this.threads.findById(scopeId);
    const profile = await this.profiles.resolveLaunchProfile({
      workspaceId: thread?.workspace_id ?? scopeId,
    });
    return this.terminalService.create(scopeId, {
      executable: profile.resolvedProfile.executable,
      arguments: [...profile.resolvedProfile.arguments],
      requestedProfileId: profile.requestedProfileId,
      resolvedProfile: profile.resolvedProfile,
    }, replacesPtyId);
  }

  /** Pauses legacy PTY output for a client request. */
  pause(ptyId: string): void {
    this.terminalService.pause(ptyId);
  }

  /** Resumes legacy PTY output for a client request. */
  resume(ptyId: string): void {
    this.terminalService.resume(ptyId);
  }

  /** Applies WebSocket buffered-byte pressure to all legacy PTYs. */
  onBufferedAmountTick(bufferedAmount: number): void {
    this.terminalService.onBufferedAmountTick(bufferedAmount);
  }

  /** Writes input to one legacy PTY. */
  write(ptyId: string, data: string): Promise<void> {
    return this.terminalService.write(ptyId, data);
  }

  /** Resizes one legacy PTY. */
  resize(ptyId: string, cols: number, rows: number): Promise<void> {
    return this.terminalService.resize(ptyId, cols, rows);
  }

  /** Closes one legacy PTY. */
  kill(
    ptyId: string,
    reason?: "user-requested-process-tree-close" | "app-shutdown",
  ): Promise<void> {
    return this.terminalService.kill(ptyId, reason);
  }

  /** Closes all legacy PTYs for one scope. */
  killByThread(threadId: string, includeActions = false): Promise<void> {
    return this.terminalService.killByThread(threadId, includeActions);
  }

  /** Closes every legacy PTY and releases service resources. */
  shutdown(): Promise<void> {
    return this.terminalService.shutdown();
  }

  /** Selects graceful process-tree shutdown for app exit. */
  setGracefulKill(enabled: boolean): void {
    this.terminalService.setGracefulKill(enabled);
  }

  /** Replays retained legacy output after reconnect. */
  reattach(ptyId: string, lastSeq: number, cold?: boolean): TerminalReattachResult {
    return this.terminalService.reattach(ptyId, lastSeq, cold);
  }

  /** Stores one bounded legacy renderer checkpoint. */
  checkpoint(ptyId: string, seq: number, data: string): { accepted: boolean } {
    return this.terminalService.checkpoint(ptyId, seq, data);
  }

  /** Lists all active legacy PTYs. */
  listActiveSessions(): LegacyTerminalRecord[] {
    return this.terminalService.listActiveSessions();
  }

  /** Reports whether one legacy PTY owns child processes. */
  hasChildren(ptyId: string): Promise<{ hasChildren: boolean }> {
    return this.terminalService.hasChildren(ptyId);
  }

  /** Opens an attachable action terminal with the same approval-bound command arguments. */
  async openActionTerminal(input: ActionTerminalRequest): Promise<ActionTerminal> {
    const thread = this.threads.findById(input.threadId);
    if (!thread || thread.deleted_at !== null) throw new Error("Action Thread is unavailable");
    const profile = await this.profiles.resolveLaunchProfile({ workspaceId: thread.workspace_id });
    const shellLaunch = {
      executable: profile.resolvedProfile.executable,
      arguments: [...profile.resolvedProfile.arguments],
      requestedProfileId: profile.requestedProfileId,
      resolvedProfile: profile.resolvedProfile,
    };
    return this.terminalService.openActionTerminal(input, shellLaunch, async (prepared, checkoutPath) => {
      // Re-resolve at every launch so a profile edit cannot reuse stale approval.
      const current = await this.profiles.resolveLaunchProfile({ workspaceId: thread.workspace_id });
      const launch = noninteractiveLaunch(current.resolvedProfile, prepared.script);
      if (!launch) throw new Error("The current Terminal profile does not support noninteractive Project Actions");
      const snapshot = {
        platform: terminalPlatform(this.hostRuntime.platform),
        script: prepared.script, checkoutPath,
        terminal: { executable: launch.executable, arguments: [...launch.arguments] },
        environmentNames: [],
      };
      if (!matchesExpectedPreparedLaunch(launch, prepared.expectedLaunch)) {
        throw new PreparedTerminalCommandApprovalMismatchError(snapshot);
      }
      return {
        snapshot,
        launch: {
          executable: launch.executable, arguments: [...launch.arguments],
          requestedProfileId: current.requestedProfileId, resolvedProfile: current.resolvedProfile,
        },
      };
    });
  }
}

function matchesExpectedPreparedLaunch(
  launch: { readonly executable: string; readonly arguments: readonly string[] },
  expected: PreparedActionLaunch["expectedLaunch"],
): boolean {
  if (!expected) return true;
  return expected.terminal?.executable === launch.executable
    && expected.terminal.arguments.length === launch.arguments.length
    && expected.terminal.arguments.every(
      (argument, index) => normalizeLaunchArgument(argument) === normalizeLaunchArgument(launch.arguments[index] ?? ""),
    );
}

function normalizeLaunchArgument(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
