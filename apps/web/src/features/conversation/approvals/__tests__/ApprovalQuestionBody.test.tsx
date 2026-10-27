import { createMockApproval } from "@mcode/contracts/testing";

import { useApprovalStore } from "@/stores/approvalStore";
import type { McodeTransport } from "@/transport/types";
import type { ApprovalQuestion, ApprovalRequest } from "@mcode/contracts";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_ARM_DELAY_MS } from "../ApprovalDock";
import { ApprovalQuestionBody } from "../ApprovalQuestionBody";

const { respondToApproval } = vi.hoisted(() => ({
  respondToApproval: vi.fn<McodeTransport["respondToApproval"]>(),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ respondToApproval }),
}));

const SINGLE: ApprovalQuestion = {
  header: "Scope",
  question: "How wide?",
  options: [{ label: "Narrow" }, { label: "Wide", description: "Whole module." }],
  multiple: false,
  custom: true,
};

const MULTIPLE: ApprovalQuestion = {
  header: "Checks",
  question: "Which checks?",
  options: [{ label: "Lint" }, { label: "Types" }],
  multiple: true,
  custom: false,
};

const CHOICES: ApprovalRequest["choices"] = [
  { id: "answer", intent: "allow_once", label: "Answer" },
  { id: "skip", intent: "deny", label: "Skip" },
];

function renderBody(questions: ApprovalQuestion[]) {
  const request = createMockApproval({ subject: { kind: "question", questions }, choices: CHOICES });
  act(() => useApprovalStore.getState().add(request));
  let armedAt = Date.now() + APPROVAL_ARM_DELAY_MS;
  render(
    <ApprovalQuestionBody
      request={useApprovalStore.getState().approvals[0]!}
      questions={questions}
      isArmed={() => Date.now() >= armedAt}
      arm={() => { armedAt = Date.now() + APPROVAL_ARM_DELAY_MS; }}
    />,
  );
  act(() => within(screen.getByRole("group")).getAllByRole("button")[0]!.focus());
}

async function elapseGuard() {
  await act(() => vi.advanceTimersByTimeAsync(APPROVAL_ARM_DELAY_MS));
}

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  respondToApproval.mockReset().mockResolvedValue({ status: "resolved" });
  useApprovalStore.setState({ approvals: [], submissions: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalQuestionBody", () => {
  it("sends the picked label with the allowing choice", async () => {
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.click(screen.getByRole("button", { name: /Wide/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "answer", answers: [["Wide"]] });
  });

  it("collects several labels for a multiple-choice question and lets a second click unpick", async () => {
    const user = setupUser();
    renderBody([MULTIPLE]);
    await elapseGuard();

    await user.click(screen.getByRole("button", { name: /Lint/ }));
    await user.click(screen.getByRole("button", { name: /Types/ }));
    await user.click(screen.getByRole("button", { name: /Lint/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "answer", answers: [["Types"]] });
  });

  it("replaces the pick with a typed answer on a single-choice question", async () => {
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.click(screen.getByRole("button", { name: /Narrow/ }));
    await user.type(screen.getByLabelText("Your own answer"), "Only the parser");
    await elapseGuard();
    await user.keyboard("{Enter}");

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "answer", answers: [["Only the parser"]] });
  });

  it("walks through every question and submits all answers from the last one", async () => {
    const user = setupUser();
    renderBody([SINGLE, MULTIPLE]);
    await elapseGuard();

    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.keyboard("1");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(respondToApproval).not.toHaveBeenCalled();
    await user.keyboard("2");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "answer", answers: [["Narrow"], ["Types"]] });
  });

  it("denies without answers on Skip and on Escape", async () => {
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.keyboard("{Escape}");

    expect(respondToApproval).toHaveBeenCalledTimes(2);
    expect(respondToApproval).toHaveBeenNthCalledWith(1, "req-1", { choiceId: "skip" });
    expect(respondToApproval).toHaveBeenNthCalledWith(2, "req-1", { choiceId: "skip" });
  });

  it("ignores a digit pressed before the guard elapses and extends the guard", async () => {
    const user = setupUser();
    renderBody([SINGLE]);

    await user.keyboard("1");
    await act(() => vi.advanceTimersByTimeAsync(APPROVAL_ARM_DELAY_MS - 100));
    await user.keyboard("1");

    expect(screen.getByRole("button", { name: /Narrow/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps a digit pick when Enter follows, instead of re-picking the row that held focus", async () => {
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.keyboard("2");
    await elapseGuard();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("button", { name: /Wide/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Narrow/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("moves focus into the custom input when its number key is pressed", async () => {
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.keyboard("3");

    expect(screen.getByLabelText("Your own answer")).toHaveFocus();
  });

  it("pages with the in-body pager and the bracket keys", async () => {
    const user = setupUser();
    renderBody([SINGLE, MULTIPLE]);
    await elapseGuard();

    await user.keyboard("]");
    expect(screen.getByText("Which checks?")).toBeInTheDocument();
    await user.keyboard("[[");
    expect(screen.getByText("How wide?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /next question/i }));
    expect(screen.getByText("Which checks?")).toBeInTheDocument();
  });

  it("keeps Submit disabled until every question has an answer", async () => {
    const user = setupUser();
    renderBody([SINGLE, MULTIPLE]);
    await elapseGuard();

    await user.keyboard("]");
    await user.keyboard("1");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    await user.keyboard("[[");
    await user.keyboard("1");
    await user.keyboard("]");
    expect(screen.getByRole("button", { name: "Submit" })).toBeEnabled();
  });

  it("returns focus to the options when paging back to an earlier question", async () => {
    const user = setupUser();
    renderBody([SINGLE, MULTIPLE]);
    await elapseGuard();

    await user.keyboard("]");
    await user.keyboard("[[");
    await user.keyboard("2");

    expect(screen.getByRole("button", { name: /Wide/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("lets Space click the focused option without re-arming the guard", async () => {
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.keyboard(" ");

    expect(screen.getByRole("button", { name: /Narrow/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an alert when the provider does not acknowledge the answer", async () => {
    respondToApproval.mockResolvedValue({ status: "failed", message: "gone" });
    const user = setupUser();
    renderBody([SINGLE]);
    await elapseGuard();

    await user.keyboard("1");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your answer didn't reach");
  });

  it("limits a typed answer to what the contract accepts", async () => {
    renderBody([SINGLE]);
    await elapseGuard();

    expect(screen.getByLabelText("Your own answer")).toHaveAttribute("maxlength", "100");
  });
});
