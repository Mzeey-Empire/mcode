import type { PlanOutput, PlanQuestion } from "@mcode/contracts";

import { PlanOutputParser } from "./plan-output-parser.js";
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

/** Parsing and output decisions for one plan execution, without database or transport dependencies. */
export class PlanExecutionState {
  private questionParser: PlanQuestionParser | undefined;
  private outputParser: PlanOutputParser | undefined;
  private pendingOutput: PlanOutput | undefined;
  private pendingExitMarkdown: string | undefined;
  private captured = false;

  beginQuestionGeneration(): void {
    this.questionParser = new PlanQuestionParser();
  }

  beginOutputGeneration(): void {
    this.outputParser = new PlanOutputParser();
    this.captured = false;
  }

  feedText(delta: string): PlanQuestionsReady | null {
    const questions = this.questionParser?.feed(delta);
    if (questions) this.questionParser = undefined;
    const output = this.outputParser?.feed(delta);
    if (output) {
      this.outputParser = undefined;
      this.pendingOutput = output;
    }
    return questions ? { questions } : null;
  }

  handleNativeExit(markdown: string): void {
    if (this.captured) return;
    this.outputParser = undefined;
    this.pendingOutput = undefined;
    this.pendingExitMarkdown = markdown;
  }

  needsAssistantMaterialization(): boolean {
    return this.pendingOutput !== undefined
      || this.pendingExitMarkdown !== undefined
      || this.outputParser !== undefined;
  }

  consumeAssistantMessage(content: string): PlanPersistenceReady | null {
    const output = this.pendingOutput;
    if (output) {
      this.pendingOutput = undefined;
      this.outputParser = undefined;
      this.pendingExitMarkdown = undefined;
      const contentMd = output.sections.map((section) => (
        `${"#".repeat(section.level + 1)} ${section.title}\n\n${section.content}`
      )).join("\n\n");
      const sectionsJson = JSON.stringify(output.sections.map((section) => ({
        id: section.id,
        title: section.title,
        level: section.level,
      })));
      return { title: output.title, contentMd, sectionsJson, changeSummary: output.changeSummary ?? null };
    }
    const markdown = this.pendingExitMarkdown;
    if (markdown) {
      this.pendingExitMarkdown = undefined;
      this.outputParser = undefined;
      return extractMarkdown(markdown);
    }
    if (!this.outputParser || !content) return null;
    this.outputParser = undefined;
    return extractMarkdown(content);
  }

  hasPersistedPlan(): boolean {
    return this.captured;
  }

  markPlanPersisted(): void {
    this.captured = true;
  }
}

function extractMarkdown(content: string): PlanPersistenceReady | null {
  let title: string | null = null;
  let nextId = 0;
  const sections: Array<{ id: string; title: string; level: number }> = [];
  for (const line of content.split("\n")) {
    const match = /^(#{1,3})\s+(.+)/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const heading = match[2].trim();
    if (!title) {
      title = heading;
      continue;
    }
    nextId += 1;
    sections.push({ id: `s${nextId}`, title: heading, level });
  }
  return title && sections.length > 0
    ? { title, contentMd: content, sectionsJson: JSON.stringify(sections), changeSummary: null }
    : null;
}
