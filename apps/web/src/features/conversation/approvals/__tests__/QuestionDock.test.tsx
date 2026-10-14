import type { PlanQuestion } from "@mcode/contracts";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_ARM_DELAY_MS } from "../ApprovalDock";
import { QuestionDock } from "../QuestionDock";
import { readThreadField, resetThreadStoreForTests } from "@/stores/thread-store-test-utils";
import { useThreadStore } from "@/stores/threadStore";

const { answerPlanQuestions, dismissPlanQuestions } = vi.hoisted(() => ({
  answerPlanQuestions: vi.fn().mockResolvedValue(undefined),
  dismissPlanQuestions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ answerPlanQuestions, dismissPlanQuestions }),
}));

const THREAD_ID = "thread-1";

const QUESTIONS: PlanQuestion[] = [
  {
    id: "q1",
    category: "SCOPE",
    question: "How wide should the change be?",
    options: [
      { id: "narrow", title: "Narrow", description: "One file." },
      { id: "wide", title: "Wide", description: "Whole module.", recommended: true },
    ],
  },
  {
    id: "q2",
    category: "TESTS",
    question: "Which tests?",
    options: [
      { id: "unit", title: "Unit", description: "Fast.", recommended: true },
      { id: "e2e", title: "End to end", description: "Slow." },
    ],
  },
];

function DockHarness({ isAgentRunning = false, onStop = () => {} }: { readonly isAgentRunning?: boolean; readonly onStop?: () => void }) {
  const composerRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <QuestionDock
        threadId={THREAD_ID}
        providerId="codex"
        composerContainerRef={composerRef}
        isAgentRunning={isAgentRunning}
        isStopPending={false}
        onStop={onStop}
        onFocusComposer={() => {}}
      />
      <div ref={composerRef} hidden><textarea aria-label="Composer" /></div>
    </>
  );
}

function setup() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

async function elapseGuard() {
  await act(() => vi.advanceTimersByTimeAsync(APPROVAL_ARM_DELAY_MS));
}

function answerOf(questionId: string) {
  return readThreadField(THREAD_ID, (record) => record.planAnswers.get(questionId));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  answerPlanQuestions.mockClear();
  dismissPlanQuestions.mockClear();
  resetThreadStoreForTests();
  act(() => useThreadStore.getState().setPlanQuestions(THREAD_ID, QUESTIONS));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("QuestionDock", () => {
  it("preselects the recommended option so Enter takes it", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();

    expect(answerOf("q1")?.selectedOptionId).toBe("wide");
    await user.keyboard("{Enter}");

    expect(screen.getByText("Which tests?")).toBeTruthy();
    expect(answerOf("q1")?.selectedOptionId).toBe("wide");
  });

  it("picks a row with its number key", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("1");

    expect(answerOf("q1")?.selectedOptionId).toBe("narrow");
  });

  it("ignores Enter until the arm delay has elapsed", async () => {
    const user = setup();
    render(<DockHarness />);

    await user.keyboard("{Enter}");

    expect(screen.getByText("How wide should the change be?")).toBeTruthy();
  });

  it("submits every answer from the last question", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("1{Enter}");
    await elapseGuard();
    await user.keyboard("{Enter}");

    expect(answerPlanQuestions).toHaveBeenCalledTimes(1);
    const [threadId, answers] = answerPlanQuestions.mock.calls[0]!;
    expect(threadId).toBe(THREAD_ID);
    expect(answers).toEqual([
      { questionId: "q1", selectedOptionId: "narrow", freeText: null },
      { questionId: "q2", selectedOptionId: "unit", freeText: null },
    ]);
  });

  it("holds Submit while the agent is still running", async () => {
    const user = setup();
    render(<DockHarness isAgentRunning />);
    await elapseGuard();

    await user.keyboard("{Enter}");
    await elapseGuard();
    await user.keyboard("{Enter}");

    expect(answerPlanQuestions).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Submit" }).hasAttribute("disabled")).toBe(true);
  });

  it("needs text before the write-your-own row can advance", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("3");
    await elapseGuard();
    await user.keyboard("{Enter}");
    expect(screen.getByText("How wide should the change be?")).toBeTruthy();

    await user.keyboard("Only the parser");
    await elapseGuard();
    await user.keyboard("{Enter}");

    expect(screen.getByText("Which tests?")).toBeTruthy();
    expect(answerOf("q1")).toEqual({ questionId: "q1", selectedOptionId: "__other__", freeText: "Only the parser" });
  });

  it("keeps Enter on Stop as a stop, not a pick-and-advance", async () => {
    const user = setup();
    const onStop = vi.fn();
    render(<DockHarness isAgentRunning onStop={onStop} />);
    await elapseGuard();

    act(() => screen.getByRole("button", { name: /Stop/ }).focus());
    await user.keyboard("{Enter}");

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(screen.getByText("How wide should the change be?")).toBeTruthy();
  });

  it("pages between questions with the bracket keys and stops at the ends", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("[[");
    expect(screen.getByText("How wide should the change be?")).toBeTruthy();
    await user.keyboard("]");
    expect(screen.getByText("Which tests?")).toBeTruthy();
    await user.keyboard("]");
    expect(screen.getByText("Which tests?")).toBeTruthy();
    await user.keyboard("[[");
    expect(screen.getByText("How wide should the change be?")).toBeTruthy();
  });

  it("dismisses the batch with Escape from the write-your-own input", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();
    await user.keyboard("3");
    act(() => vi.advanceTimersByTime(50));
    await user.keyboard("Only the parser");

    await user.keyboard("{Escape}");

    expect(dismissPlanQuestions).toHaveBeenCalledWith(THREAD_ID);
  });

  it("dismisses the batch with Escape", async () => {
    const user = setup();
    render(<DockHarness />);
    await elapseGuard();

    await user.keyboard("{Escape}");

    expect(dismissPlanQuestions).toHaveBeenCalledWith(THREAD_ID);
    expect(readThreadField(THREAD_ID, (record) => record.planQuestionsStatus)).toBe("idle");
  });
});
