import type { LegacyTerminalRecord, LegacyTerminalCreateResult,
  TerminalBackendCapabilities,
  TerminalErrorCode,
  TerminalProfileInUseData,
  TerminalRetryClass,
  WorkspaceEnvironmentActionLaunchSnapshot,
} from "@mcode/contracts";
import type { WebSocket } from "ws";

/** Dependency-injection token for the server Terminal backend. */
export const TERMINAL_BACKEND_TOKEN = "TerminalBackend";

/** Streams legacy Terminal output and exit events to connected clients. */
export interface TerminalBackendSender {
  json(channel: string, data: Record<string, unknown>): void;
  data(ptyId: string, seq: number, bytes: Uint8Array): void;
  frame?(client: WebSocket, bytes: Uint8Array): void;
}

/** Typed failure returned by the Terminal management boundary. */
export class TerminalBackendError extends Error {
  readonly correlationId: string;

  constructor(
    readonly code: TerminalErrorCode,
    readonly retry: TerminalRetryClass,
    message: string,
    correlationId = `corr-${crypto.randomUUID()}`,
    readonly data?: TerminalProfileInUseData,
  ) {
    super(message);
    this.name = "TerminalBackendError";
    this.correlationId = correlationId;
  }
}

/** Result of a legacy Terminal reattachment. */
export type TerminalReattachResult =
  | { mode: "delta" }
  | { mode: "checkpoint"; checkpoint: string; checkpointThrough: number }
  | { mode: "reset"; discardThrough: number };

/** A Terminal create that completed after its owning WebSocket disconnected. */
export type DisconnectedTerminalCreate = { readonly method: "terminal.create"; readonly ptyId: string };

/** Exact script and approval binding for a command phase. */
export interface PreparedActionLaunch {
  readonly script: string;
  readonly expectedLaunch?: PreparedTerminalCommandExpectation;
}

/** One attachable terminal whose command process is followed by an interactive shell. */
export interface ActionTerminal {
  readonly terminalSessionId: string;
  /** Actual latest launch facts, or null before the first command starts. */
  readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot | null;
  run(launch: PreparedActionLaunch): Promise<WorkspaceEnvironmentActionLaunchSnapshot>;
  stopCommand(): Promise<void>;
  /** Command process bytes only, excluding the synthesized echo and interactive shell. */
  onCommandOutput(listener: (bytes: Uint8Array) => void): () => void;
  onCommandExit(listener: (exit: { readonly exitCode: number | null }) => void): () => void;
  onClosed(listener: () => void): () => void;
}

/** Typed pre-spawn failure that preserves resolved Action launch facts without environment values. */
export class PreparedTerminalCommandStartError extends Error {
  constructor(
    readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot,
    readonly original: unknown,
  ) {
    super("Prepared command session creation failed");
    this.name = "PreparedTerminalCommandStartError";
  }
}

/** Exact launch facts that a shared-command approval bound before the backend starts a session. */
export interface PreparedTerminalCommandExpectation {
  readonly terminal: {
    readonly executable: string;
    readonly arguments: readonly string[];
  } | null;
}

/** Typed pre-spawn failure raised when the Terminal profile changed after shared-command approval. */
export class PreparedTerminalCommandApprovalMismatchError extends Error {
  constructor(readonly snapshot: WorkspaceEnvironmentActionLaunchSnapshot) {
    super("Prepared command approval no longer matches the Terminal launch");
    this.name = "PreparedTerminalCommandApprovalMismatchError";
  }
}

/** Reserves an action terminal, optionally starting its first approved command. */
export interface ActionTerminalRequest {
  readonly threadId: string;
  readonly actionId: string;
  readonly echo: string;
  readonly launch: PreparedActionLaunch | "pending-approval";
}

/** Server Terminal backend used by server orchestration and transport. */
export abstract class TerminalBackend {
  abstract capabilities(): TerminalBackendCapabilities;
  abstract setSender(sender: TerminalBackendSender): void;
  abstract create(scopeId: string, replacesPtyId?: string): Promise<LegacyTerminalCreateResult>;
  abstract pause(ptyId: string): void;
  abstract resume(ptyId: string): void;
  abstract onBufferedAmountTick(bufferedAmount: number): void;
  abstract write(ptyId: string, data: string): Promise<void>;
  abstract resize(ptyId: string, cols: number, rows: number): Promise<void>;
  abstract kill(
    ptyId: string,
    reason?: "user-requested-process-tree-close" | "app-shutdown",
  ): Promise<void>;
  abstract killByThread(threadId: string): Promise<void>;
  abstract shutdown(): Promise<void>;
  abstract setGracefulKill(enabled: boolean): void;
  abstract reattach(ptyId: string, lastSeq: number, cold?: boolean): TerminalReattachResult;
  abstract checkpoint(ptyId: string, seq: number, data: string): { accepted: boolean };
  abstract listActiveSessions(): LegacyTerminalRecord[];
  abstract hasChildren(ptyId: string): Promise<{ hasChildren: boolean }>;

  /** Opens a retained action terminal using the backend's normal capacity and flow control. */
  abstract openActionTerminal(input: ActionTerminalRequest): Promise<ActionTerminal>;

  /** Releases controller leases and uploads owned by a disconnected client. */
  disconnectClient(_client: WebSocket): void {}

  /** Reclaims a Terminal that was created after its requesting WebSocket disconnected. */
  async cleanupDisconnectedCreate(create: DisconnectedTerminalCreate, _client: WebSocket): Promise<void> {
    await this.kill(create.ptyId);
  }
}
