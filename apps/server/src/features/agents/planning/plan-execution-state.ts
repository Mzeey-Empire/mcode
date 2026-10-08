import type { PlanCapture, PlanQuestion } from "@mcode/contracts";
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

/** A planning turn explicitly reports when no plan was captured. */
export type PlanCaptureOutcome = { outcome: "captured" } | { outcome: "missing" };

/** Parsing and capture decisions for one plan execution, without database or transport dependencies. */
export class PlanExecutionState {
  private questionParser: PlanQuestionParser | undefined;
  private fenceParser: PlanFenceParser | undefined;
  private pendingCapture: Pick<PlanCapture, "markdown" | "source"> | undefined;
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
  handlePlanCapture(capture: Pick<PlanCapture, "markdown" | "source">): void {
    if (!this.planning || this.captured || !capture.markdown.trim() || capture.markdown.length > 256 * 1024
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
    return capture ? extractMarkdown(capture.markdown) : null;
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

function extractMarkdown(content: string): PlanPersistenceReady | null {
  const headings = [...markdownHeadings(content)];
  const titleHeading = headings.find((heading) => heading.level === 1);
  const title = titleHeading?.title ?? headings[0]?.title ?? firstProseLine(content) ?? "Plan";
  return title ? { title: title.slice(0, 200), contentMd: content,
    sectionsJson: planNavigation(headings.filter((heading) => heading !== titleHeading)), changeSummary: null } : null;
}

function planNavigation(headings: Array<{ title: string; level: number }>): string {
  let sectionsLength = 2;
  const sections: Array<{ id: string; title: string; level: number }> = [];
  for (const heading of headings) {
    const section = { id: `s${sections.length + 1}`, ...heading };
    const length = JSON.stringify(section).length + Number(sections.length > 0);
    if (sections.length >= 128 || sectionsLength + length > 64 * 1024) break;
    sections.push(section);
    sectionsLength += length;
  }
  return JSON.stringify(sections);
}

function firstProseLine(content: string): string | undefined {
  for (const line of proseLines(content)) if (line.trim()) return line.trim();
  return undefined;
}

function* markdownHeadings(content: string): Generator<{ title: string; level: number }> {
  for (const line of proseLines(content)) {
    const match = /^ {0,3}(#{1,3})[ \t]+(.+)/.exec(line);
    if (!match) continue;
    const title = match[2].replace(/\s+#+\s*$/, "").trim().slice(0, 200);
    if (title) yield { title, level: match[1].length };
  }
}

/** Lines outside code fences, so code never supplies a title or section. */
function* proseLines(content: string): Generator<string> {
  let fence: { marker: string; length: number } | null = null;
  for (const line of content.split("\n")) {
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (code) {
      if (!fence) fence = { marker: code[1][0], length: code[1].length };
      else if (code[1][0] === fence.marker && code[1].length >= fence.length && !code[2].trim()) fence = null;
      continue;
    }
    if (!fence) yield line;
  }
}
