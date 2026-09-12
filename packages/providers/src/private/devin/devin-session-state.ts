import type * as NodeChildProcess from "node:child_process";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { DevinMode } from "@mcode/contracts";
import type { AcpSessionRuntime } from "../protocols/acp/acp-session-runtime.js";
import type { DevinAcpTurnState } from "./devin-acp-event-mapper.js";

/**
 * Metadata retained per ACP tool_call id so `session/request_permission`
 * payloads — which may carry only a `toolCallId` — can be correlated back to
 * the tool that triggered them.
 */
export interface DevinToolCallSnapshot {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
}

/** Stores the mutable state for one long-lived Devin ACP session. */
export interface DevinAcpSessionEntry {
  mcodeSessionId: string;
  threadId: string;
  child: NodeChildProcess.ChildProcess;
  connection: ClientSideConnection;
  acpRuntime: AcpSessionRuntime;
  /** Logical ACP session id (empty until `session/new` or `session/load`). */
  acpSessionId: string;
  cwd: string;
  /** Coarse Mcode permission mode at spawn time. */
  permissionMode: "full" | "default";
  /** Native Devin mode resolved for the current turn. */
  devinMode: DevinMode;
  lastUsedAt: number;
  turnChain: Promise<void>;
  activeTurnState: DevinAcpTurnState | null;
  /** Turn state used while a `session/load` replay streams before a prompt. */
  replayTurnState: DevinAcpTurnState | null;
  pendingUserStopAbort: boolean;
  /** Dedupe pair: model already applied to this logical session. */
  modelAppliedPair: { acpSessionId: string; modelId: string } | null;
  /** Dedupe pair: native mode already applied to this logical session. */
  modeAppliedPair: { acpSessionId: string; mode: DevinMode } | null;
  /** Modes the session advertises via `config_option_update`; null until known. */
  advertisedModes: Set<DevinMode> | null;
  /** toolCallId -> snapshot for permission-request correlation. */
  toolCallById: Map<string, DevinToolCallSnapshot>;
  /** Unresolved `run_subagent` toolCallIds for orphan subagent updates. */
  pendingSubagentCallIds: string[];
  /** agentId -> owning run_subagent toolCallId. */
  subagentParentByAgentId: Map<string, string>;
  /** Model label reported by `_cognition.ai/agent_stopped` for the active turn. */
  stoppedModelLabel: string | null;
  stderrTailLines: string[];
}

/** Identifies a state entry owned by the shared session runtime. */
export type DevinSessionState = DevinAcpSessionEntry;
