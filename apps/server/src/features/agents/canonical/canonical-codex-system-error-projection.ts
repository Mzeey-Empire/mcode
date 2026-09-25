import type { Database } from "bun:sqlite";
import * as NodeUtil from "node:util";
import { ProviderIdSchema, type AgentEvent, type ProviderId } from "@mcode/contracts";

import { ThreadRepo } from "../../thread-control/persistence/thread-repo.js";
import { MessageRepo } from "../conversation/persistence/message-repo.js";
import type { CodexLiveReduction, CodexLiveWriterIntent } from "../execution/codex-live-event-reducer.js";
import type { ExecutionIdentity } from "../execution/execution-mailbox-protocol.js";
import type { DataOnlyParentTerminalProjectionInput } from "./canonical-parent-turn-write.js";
import { CanonicalAgentBoundary } from "./canonical-agent-boundary.js";

type Reduced = Extract<CodexLiveReduction, { kind: "reduced" }>;
type SystemEvent = Extract<AgentEvent, { type: "system" }>;
/** System intents accepted by the execution-bound live writer. */
export type CodexSystemWriterIntent = Extract<CodexLiveWriterIntent, { kind: "notice-session" | "system-notice" | "session-cursor" }>;
type ErrorTerminalIntent = Extract<CodexLiveWriterIntent, { kind: "terminal-projection" }>;

function errorTerminalIntent(reduction: Reduced, event: Extract<AgentEvent, { type: "error" }>): ErrorTerminalIntent {
  const error = reduction.writer.find((intent) => intent.kind === "turn-error");
  const terminal = reduction.writer.find((intent) => intent.kind === "terminal-projection");
  if (error?.kind !== "turn-error" || error.error !== event.error
    || terminal?.kind !== "terminal-projection" || terminal.source !== "error" || terminal.outcome !== "errored") {
    throw new Error("Codex error needs an errored terminal projection and end time");
  }
  return terminal;
}

/** Cloneable result of writer-local system projection or error terminal preparation. */
export type CanonicalCodexSystemErrorResult =
  | SystemProjectionResult
  | { readonly kind: "error-terminal"; readonly event: Extract<AgentEvent, { type: "error" }>; readonly after: "terminal"; readonly input: DataOnlyParentTerminalProjectionInput };

type SystemProjectionResult = { readonly kind: "system"; readonly event: SystemEvent; readonly after: "writer" | "terminal" };

function expectedSystemIntentKind(event: SystemEvent): CodexSystemWriterIntent["kind"] | null {
  if (event.subtype === "provider.session.started") return "notice-session";
  if (event.subtype.startsWith("provider.notice.") && event.message) return "system-notice";
  if (event.subtype.startsWith("sdk_session_id:") || event.subtype === "sdk_session_invalidated") return "session-cursor";
  return null;
}

/** Check that a bound system event carries exactly its reducer-owned projection intent. */
export function matchesCodexSystemIntents(event: SystemEvent, intents: readonly CodexSystemWriterIntent[]): boolean {
  const expected = expectedSystemIntentKind(event);
  if (!Array.isArray(intents) || intents.length !== (expected ? 1 : 0)) return false;
  if (!expected) return true;
  return intents[0]?.kind === expected && NodeUtil.isDeepStrictEqual(intents[0].event, event)
    && (expected !== "system-notice" || !event.messageId);
}

function isSystemWriterIntent(intent: CodexLiveWriterIntent): intent is CodexSystemWriterIntent {
  return intent.kind === "notice-session" || intent.kind === "system-notice" || intent.kind === "session-cursor";
}

/** Projects only execution-bound Codex system events and prepares errors for the terminal owner. */
export class CanonicalCodexSystemErrorProjection {
  private readonly threads: ThreadRepo;
  private readonly messages: MessageRepo;
  private readonly canonical: CanonicalAgentBoundary;

  constructor(private readonly db: Database) {
    this.threads = new ThreadRepo(db);
    this.messages = new MessageRepo(db);
    this.canonical = new CanonicalAgentBoundary(db, () => {});
  }

  /** Call inside the canonical append transaction, before its receipt and publication. Errors still require terminal staging and finish. */
  project(reduction: CodexLiveReduction, endedAt?: string): CanonicalCodexSystemErrorResult {
    if (reduction.kind !== "reduced") throw new Error("Unsupported Codex event cannot be projected");
    const event = reduction.publication.event;
    if (event.threadId !== reduction.execution.threadId || event.turnExecutionId !== reduction.execution.executionId) {
      throw new Error("Codex event lacks exact execution ownership");
    }
    if (event.type === "system") {
      if (!reduction.writer.every(isSystemWriterIntent)) throw new Error("Codex system has a non-system intent");
      return this.projectBoundSystem(reduction.execution, "codex", event, reduction.writer, reduction.publication.after);
    }
    if (event.type === "error") return this.prepareError(reduction, event, endedAt);
    throw new Error(`Codex ${event.type} needs another feature owner`);
  }

  /** Apply one bound system event and return the event that the committed receipt must publish. */
  projectBoundSystem(
    execution: ExecutionIdentity,
    providerId: string,
    event: SystemEvent,
    intents: readonly CodexSystemWriterIntent[],
    after: "writer" | "terminal",
  ): SystemProjectionResult {
    if (event.threadId !== execution.threadId || event.turnExecutionId !== execution.executionId) {
      throw new Error("Codex system event lacks exact execution ownership");
    }
    if (!matchesCodexSystemIntents(event, intents)) {
      throw new Error("Codex system intents do not match the event");
    }
    const provider = ProviderIdSchema.parse(providerId);
    if (provider !== "codex" && provider !== "claude" && provider !== "cursor") {
      throw new Error(`Provider ${provider} has no execution-bound system projection`);
    }
    return this.db.transaction(() => {
      let published: SystemEvent = { ...event };
      for (const intent of intents) {
        published = this.applySystemIntent(execution.executionId, provider, intent, published);
      }
      return structuredClone({ kind: "system", event: published, after } satisfies SystemProjectionResult);
    })();
  }

  private applySystemIntent(executionId: string, providerId: ProviderId, intent: CodexSystemWriterIntent, event: SystemEvent): SystemEvent {
    switch (intent.kind) {
      case "notice-session":
        if (event.subtype !== "provider.session.started") throw new Error("Codex notice session subtype is invalid");
        this.messages.beginNoticeSession(event.threadId, event.systemNotice?.sessionId);
        return event;
      case "system-notice": {
        if (!event.subtype.startsWith("provider.notice.") || !event.message) throw new Error("Codex notice is invalid");
        const sequence = this.messages.getLatestSequenceIncludingInternal(event.threadId) + 1;
        const message = this.messages.createSystemNotice(event.threadId, event.message ?? "", sequence, event.systemNotice);
        return { ...event, messageId: message.id };
      }
      case "session-cursor":
        this.applyCursor(executionId, providerId, event);
        return event;
    }
  }

  private applyCursor(executionId: string, providerId: ProviderId, event: SystemEvent): void {
    if (event.subtype === "sdk_session_invalidated") {
      if (!this.threads.clearSdkSessionId(event.threadId)) throw new Error("Codex cursor thread is missing");
      return;
    }
    if (!event.subtype.startsWith("sdk_session_id:")) throw new Error("Codex cursor subtype is invalid");
    const cursor = event.subtype.slice("sdk_session_id:".length);
    if (!cursor) return;
    if (!this.threads.updateSdkSessionId(event.threadId, cursor)
      || !this.canonical.recordNativeCursor(executionId, {
        providerId, scope: providerId === "codex" ? "thread" : "session", value: cursor, provenance: "native",
      })) throw new Error("Codex cursor could not be persisted for this execution");
  }

  private prepareError(reduction: Reduced, event: Extract<AgentEvent, { type: "error" }>, endedAt?: string): CanonicalCodexSystemErrorResult {
    if (reduction.publication.after !== "terminal" || !endedAt || !Number.isFinite(Date.parse(endedAt))) {
      throw new Error("Codex error needs an errored terminal projection and end time");
    }
    const terminal = errorTerminalIntent(reduction, event);
    return structuredClone({
      kind: "error-terminal",
      event,
      after: "terminal",
      input: {
        threadId: reduction.execution.threadId,
        executionId: reduction.execution.executionId,
        outcome: "errored",
        endedAt,
        assistant: terminal.assistant,
        narrative: terminal.narrative,
      },
    } satisfies CanonicalCodexSystemErrorResult);
  }
}
