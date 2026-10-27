import { SUBAGENT_REPORTING } from "@mcode/contracts/providers/interfaces";
import { createCanonicalSubagentPresentation } from "@mcode/contracts/models/tool-call-record";
import { type AgentEvent } from "@mcode/contracts/events/agent-event";
import { type ChildThreadEvidence } from "@mcode/contracts/events/provider-runtime-event";
import { ChildThreadRejection, type ChildThreadHandle, type ChildThreadReads,
  type ChildThreadRecorder } from "../child-thread-recorder.js";
import type { ProviderEventProjection } from "../../../providers/composition/provider-event-adapter.js";
import type { ProviderEventIngressEvent } from "../../../providers/composition/provider-event-ingress.js";

/** Evidence-kind dispatch shared by native and neutral adapters. */
export interface ExtensionAdapter {
  project(input: ProviderEventIngressEvent): ProviderEventProjection;
}

/** Interprets child evidence for providers that declare transcript support. */
export class ChildThreadEventAdapter implements ExtensionAdapter {
  constructor(private readonly recorder: ChildThreadRecorder & ChildThreadReads) {}

  /** Reject child data problems without failing the owning parent turn. */
  project(input: ProviderEventIngressEvent): ProviderEventProjection {
    const extension = input.runtimeExtension;
    if (extension?.kind !== "child-thread") return { status: "forward", event: input.event };
    try {
      if (!SUBAGENT_REPORTING[input.providerId]?.childTranscript) throw new ChildThreadRejection("child-transcript-not-declared");
      return this.projectEvidence(input.event, extension.childThread, input.providerId);
    } catch (error) {
      if (!(error instanceof ChildThreadRejection)) throw error;
      const diagnostic = { threadId: input.event.threadId, executionId: input.event.turnExecutionId,
        parentItemId: `toolCall:${extension.childThread.path[0]}`, event: input.event, reason: error.reason };
      this.recorder.reject(diagnostic);
      return { status: "rejected", diagnostic };
    }
  }

  private projectEvidence(event: AgentEvent, evidence: ChildThreadEvidence,
    providerId: ProviderEventIngressEvent["providerId"]): ProviderEventProjection {
    const owner = this.resolveOwner(event, evidence.path.slice(0, -1));
    const nativeParentItemId = evidence.path.at(-1);
    if (!nativeParentItemId) throw new ChildThreadRejection("unknown-delegation");
    const parentItemId = `toolCall:${nativeParentItemId}`;
    if (evidence.role === "delegate") {
      const child = this.recorder.delegate({ providerId, parentThreadId: owner.threadId, parentTurnId: owner.turnId,
        parentItemId, nativeParentItemId, prompt: evidence.prompt, title: evidence.title, agentType: evidence.agentType });
      if (evidence.path.length > 1) return { status: "consumed" };
      if (event.type !== "toolUse") throw new ChildThreadRejection("unsupported-event-type");
      return { status: "forward", event: { ...event,
        subagentPresentation: createCanonicalSubagentPresentation(event.toolInput, event.toolCallId, child.childThreadId) } };
    }
    const child = this.recorder.findDelegation(owner.threadId, parentItemId);
    if (!child) throw new ChildThreadRejection("unknown-delegation");
    this.recordObservation(child, event, evidence);
    return { status: "consumed" };
  }

  private resolveOwner(event: AgentEvent, segments: readonly string[]): { threadId: string; turnId: string } {
    const turn = this.recorder.loadTurnByExecution(event.turnExecutionId ?? "");
    if (!turn || turn.threadId !== event.threadId) throw new ChildThreadRejection("parent-turn-not-running");
    let owner = { threadId: turn.threadId, turnId: turn.id };
    for (const segment of segments) {
      const child = this.recorder.findDelegation(owner.threadId, `toolCall:${segment}`);
      if (!child) throw new ChildThreadRejection("unknown-delegation");
      owner = { threadId: child.childThreadId, turnId: child.turnId };
    }
    return owner;
  }

  private recordObservation(child: ChildThreadHandle, event: AgentEvent,
    evidence: Extract<ChildThreadEvidence, { role: "child" }>): void {
    switch (event.type) {
      case "textDelta":
        if (!evidence.nativeItemId) throw new ChildThreadRejection("missing-native-item-id");
        this.recorder.recordChildItem(child, { kind: "message", nativeItemId: evidence.nativeItemId,
          text: event.delta, mode: evidence.final ? "replace" : "append" });
        return;
      case "toolUse":
        this.recorder.recordChildItem(child, { kind: "tool-call", nativeItemId: event.toolCallId,
          toolName: event.toolName, toolInput: event.toolInput });
        return;
      case "toolResult":
        this.recorder.recordChildItem(child, { kind: "tool-result", nativeItemId: event.toolCallId,
          output: event.output, isError: event.isError ?? false });
        return;
      case "turnComplete":
        this.recorder.closeChild(child, { outcome: "completed" });
        return;
      case "error":
        this.recorder.closeChild(child, { outcome: "errored", error: event.error });
        return;
      case "ended":
        this.closeEnded(child, event);
        return;
      default:
        throw new ChildThreadRejection("unsupported-event-type");
    }
  }

  private closeEnded(child: ChildThreadHandle, event: Extract<AgentEvent, { type: "ended" }>): void {
    const outcome = event.outcome ?? "interrupted";
    this.recorder.closeChild(child, outcome === "errored"
      ? { outcome, error: event.reason ?? "Child interrupted by parent failure" } : { outcome });
  }
}
