import type { PlanCaptured, PlanQuestion } from "@mcode/contracts";
import { PlanFenceParser } from "@mcode/shared";
import { PlanQuestionParser } from "./plan-question-parser.js";

/** Parsed questions ready for the service to publish. */
export interface PlanQuestionsReady {
  questions: PlanQuestion[];
}

/** Plan data ready for the service to persist against an assistant message. */
export interface PlanPersistenceReady {
  title: string;
  contentMd: string;
  sectionsJson: string;
  changeSummary: string | null;
}

/** A planning turn reports missing capture separately from ordinary conversation. */
export type PlanCaptureOutcome = { outcome: "inactive" | "missing" } | {
  outcome: "captured";
  source: PlanCaptured["source"];
};

/** Parsing and output decisions for one plan execution, without database or transport dependencies. */
export class PlanExecutionState {
  private questionParser: PlanQuestionParser | undefined;
  private fenceParser: PlanFenceParser | undefined;
  private pending: Pick<PlanCaptured, "markdown" | "source"> | undefined;
  private captured = false;
  private source: PlanCaptured["source"] | undefined;

  /** Prepare plans without consuming the accepted parser or materialization state. */
  fork(): PlanExecutionState {
    const copy = new PlanExecutionState();
    copy.questionParser = this.questionParser?.fork();
    copy.fenceParser = this.fenceParser?.fork();
    copy.pending = this.pending && { ...this.pending };
    copy.captured = this.captured;
    copy.source = this.source;
    return copy;
  }

  /** Arm the question parser for one question turn. */
  beginQuestionGeneration(): void {
    this.questionParser = new PlanQuestionParser();
  }

  /** Arm fence capture for one planning or revision turn. */
  beginOutputGeneration(): void {
    this.fenceParser = new PlanFenceParser();
    this.pending = undefined;
    this.captured = false;
    this.source = undefined;
  }

  /** Feed provider text without treating ordinary prose as a plan. */
  feedText(delta: string): PlanQuestionsReady | null {
    const questions = this.questionParser?.feed(delta);
    if (questions) this.questionParser = undefined;
    const markdown = this.fenceParser?.feed(delta);
    if (markdown) this.handleCapture({ markdown, source: "fence" });
    return questions ? { questions } : null;
  }

  /** Prefer native capture over the fallback, regardless of arrival order. */
  handleCapture(capture: Pick<PlanCaptured, "markdown" | "source">): void {
    if (this.captured || !capture.markdown.trim() || this.pending?.source === "native") return;
    this.pending = capture;
    this.source = capture.source;
  }

  /** Whether a planning turn may need an assistant row for its captured plan. */
  needsAssistantMaterialization(): boolean {
    return !this.captured && (this.pending !== undefined || this.fenceParser !== undefined);
  }

  /** Capture complete message text when a provider did not stream it. */
  observeAssistantMessage(content: string): void {
    if (!this.fenceParser || this.captured) return;
    const streamed = this.fenceParser.finish();
    if (streamed) this.handleCapture({ markdown: streamed, source: "fence" });
    if (this.pending) return;
    const parser = new PlanFenceParser();
    const markdown = parser.feed(content) ?? parser.finish();
    if (markdown) this.handleCapture({ markdown, source: "fence" });
    this.fenceParser = new PlanFenceParser();
  }

  /** Materialize only an explicit capture, never headings scraped from chat. */
  consumeAssistantMessage(content: string): PlanPersistenceReady | null {
    if (this.captured) return null;
    this.observeAssistantMessage(content);
    const capture = this.pending;
    if (!capture) return null;
    return extractMarkdown(capture.markdown);
  }

  /** Report the terminal capture outcome without persisting a no-plan record. */
  outcome(): PlanCaptureOutcome {
    if (this.source) return { outcome: "captured", source: this.source };
    return { outcome: this.fenceParser ? "missing" : "inactive" };
  }

  /** Whether this execution already created a durable plan. */
  hasPersistedPlan(): boolean {
    return this.captured;
  }

  /** Prevent duplicate versions from replayed assistant messages. */
  markPlanPersisted(): void {
    this.captured = true;
    this.pending = undefined;
    this.fenceParser = undefined;
  }
}

function extractMarkdown(content: string): PlanPersistenceReady {
  let title: string | undefined;
  const sections: Array<{ id: string; title: string; level: number }> = [];
  for (const { level, heading } of markdownHeadings(content)) {
    if (level === 1 && title === undefined) title = heading;
    else sections.push({ id: `s${sections.length + 1}`, title: heading, level });
  }
  return { title: title ?? "Untitled plan", contentMd: content, sectionsJson: JSON.stringify(sections), changeSummary: null };
}

function* markdownHeadings(content: string): Generator<{ level: number; heading: string }> {
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,3})\s+(.+)/.exec(line);
    if (match) yield { level: match[1].length, heading: match[2].trim() };
  }
}
