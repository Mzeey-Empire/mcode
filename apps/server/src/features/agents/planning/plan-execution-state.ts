import { PLAN_MAX_CONTENT_CHARS, type PlanCapture, type PlanQuestion } from "@mcode/contracts";
import type { z } from "zod";
import { PlanPersistenceReadySchema } from "./plan-capture-schema.js";
import { planTitle } from "./plan-title.js";
import { PlanFenceParser } from "@mcode/shared";
import { PlanQuestionParser } from "./plan-question-parser.js";

/** Parsed questions ready for the service to publish. */
export interface PlanQuestionsReady {
  questions: PlanQuestion[];
}

/** Plan data ready for the service to persist against an assistant message. */
export type PlanPersistenceReady = z.infer<ReturnType<typeof PlanPersistenceReadySchema>>;

/** A planning turn explicitly reports when no plan was captured. */
export type PlanCaptureOutcome = { outcome: "captured" } | { outcome: "missing" };

/** Parsing and capture decisions for one plan execution, without database or transport dependencies. */
export class PlanExecutionState {
  private questionParser: PlanQuestionParser | undefined;
  private fenceParser: PlanFenceParser | undefined;
  private pendingCapture: Omit<PlanCapture, "threadId"> | undefined;
  private planning = false;
  private captured = false;

  /** Prepare plans without consuming the accepted parser or materialization state. */
  fork(): PlanExecutionState {
    const copy = new PlanExecutionState();
    copy.questionParser = this.questionParser?.fork();
    copy.fenceParser = this.fenceParser?.fork();
    copy.pendingCapture = this.pendingCapture ? { ...this.pendingCapture } : undefined;
    copy.planning = this.planning;
    copy.captured = this.captured;
    return copy;
  }

  /** Arm the separate question protocol. */
  beginQuestionGeneration(): void {
    this.questionParser = new PlanQuestionParser();
  }

  /** Arm markdown capture for a planning or revision turn. */
  beginOutputGeneration(): void {
    this.fenceParser = new PlanFenceParser();
    this.pendingCapture = undefined;
    this.planning = true;
    this.captured = false;
  }

  /** Consume streamed questions or a fenced plan. */
  feedText(delta: string): PlanQuestionsReady | null {
    const questions = this.questionParser?.feed(delta);
    if (questions) this.questionParser = undefined;
    const markdown = this.fenceParser?.feed(delta);
    if (markdown) this.handlePlanCapture({ markdown, source: "fence" });
    return questions ? { questions } : null;
  }

  /** Native output takes precedence over a pending fence capture. */
  handlePlanCapture(capture: Omit<PlanCapture, "threadId">): void {
    if (!this.planning || this.captured || !capture.markdown.trim() || capture.markdown.length > PLAN_MAX_CONTENT_CHARS
      || this.pendingCapture?.source === "native") return;
    this.pendingCapture = capture;
  }

  /** Finish the current text item before another item or tool can append text. */
  finishTextItem(): void {
    const markdown = this.fenceParser?.finish();
    if (markdown) this.handlePlanCapture({ markdown, source: "fence" });
    if (this.fenceParser) this.fenceParser = new PlanFenceParser();
  }

  /** Keep assistant materialization armed until a valid capture can be persisted. */
  needsAssistantMaterialization(): boolean {
    return this.planning && !this.captured;
  }

  /** Read only explicit fences from complete messages; prose headings are never a plan. */
  consumeAssistantMessage(content: string): PlanPersistenceReady | null {
    if (!this.planning || this.captured) return null;
    const streamed = this.fenceParser?.finish();
    const messageParser = new PlanFenceParser();
    messageParser.feed(content);
    const markdown = streamed ?? messageParser.finish();
    if (markdown) this.handlePlanCapture({ markdown, source: "fence" });
    this.fenceParser = new PlanFenceParser();
    const capture = this.pendingCapture;
    this.pendingCapture = undefined;
    return capture ? { title: planTitle(capture.markdown), contentMd: capture.markdown,
      captureSource: capture.source, ...(capture.nativePlanFile ? { nativePlanFile: capture.nativePlanFile } : {}) } : null;
  }

  /** Return the planning result without creating a persisted phase. */
  finishTurn(): PlanCaptureOutcome | null {
    return this.planning ? { outcome: this.captured ? "captured" : "missing" } : null;
  }

  /** Report whether this execution already owns a plan version. */
  hasPersistedPlan(): boolean {
    return this.captured;
  }

  /** Prevent a second version after the first capture was accepted. */
  markPlanPersisted(): void {
    this.captured = true;
  }
}
