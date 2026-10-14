import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PlanQuestion } from "@mcode/contracts";
import { AnsweredSummary } from "../AnsweredSummary";

function question(id: string): PlanQuestion {
  return {
    id,
    category: "AUTH",
    question: `Question ${id}?`,
    options: [
      { id: "o1", title: "Yes", description: "Do it" },
      { id: "o2", title: "No", description: "Skip it" },
    ],
  };
}

function fence(questions: readonly unknown[]): string {
  return `Some context.\n\`\`\`plan-questions\n${JSON.stringify(questions)}\n\`\`\`\n`;
}

describe("AnsweredSummary", () => {
  afterEach(cleanup);

  it("counts every question in the batch", () => {
    render(<AnsweredSummary content={fence([question("q1"), question("q2")])} />);
    expect(screen.getByText("Answered 2 questions")).toBeTruthy();
  });

  it("uses the singular for one question", () => {
    render(<AnsweredSummary content={fence([question("q1")])} />);
    expect(screen.getByText("Answered 1 question")).toBeTruthy();
  });

  it("renders nothing when any question in the batch is invalid", () => {
    const invalid = { ...question("q2"), options: [] };
    const { container } = render(<AnsweredSummary content={fence([question("q1"), invalid])} />);
    expect(container.innerHTML).toBe("");
  });
});
