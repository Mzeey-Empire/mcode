import { createMockApproval } from "@/__tests__/mocks/transport";
import type { McodeTransport } from "@/transport/types";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionRequestCard } from "./PermissionRequestCard";

const { respondToApproval } = vi.hoisted(() => ({
  respondToApproval: vi.fn<McodeTransport["respondToApproval"]>().mockResolvedValue({ status: "resolved" }),
}));

vi.mock("@/transport", () => ({
  getTransport: () => ({ respondToApproval }),
}));

const questions = [
  {
    header: "Deploy",
    question: "Deploy now?",
    options: [{ label: "Yes" }, { label: "No" }],
    multiple: false,
    custom: false,
  },
  {
    header: "Regions",
    question: "Choose regions",
    options: [{ label: "East" }, { label: "West" }],
    multiple: true,
    custom: false,
  },
  {
    header: "Notes",
    question: "Anything else?",
    options: [],
    multiple: false,
    custom: true,
  },
];

function renderQuestionCard() {
  render(
    <PermissionRequestCard
      request={{ ...createMockApproval({ requestId: "que_1", subject: { kind: "question", questions }, noteDelivery: "none" }), settled: false }}
    />,
  );
}

describe("PermissionRequestCard question flow", () => {
  beforeEach(() => {
    respondToApproval.mockClear();
  });

  it("collects single, multiple, and custom answers without offering session approval", async () => {
    const user = userEvent.setup();
    renderQuestionCard();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());

    expect(screen.getByRole("button", { name: "Submit answers" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Change allow mode" })).not.toBeInTheDocument();
    expect(screen.queryByText("Allow in session")).not.toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Yes" }));
    await user.click(screen.getByRole("checkbox", { name: "East" }));
    await user.click(screen.getByRole("checkbox", { name: "West" }));
    await user.type(screen.getByRole("textbox", { name: "Custom answer for Notes" }), "ship after review");
    await user.click(screen.getByRole("button", { name: "Submit answers" }));

    expect(respondToApproval).toHaveBeenCalledWith(
      "que_1",
      { choiceId: "allow", answers: [["Yes"], ["East", "West"], ["ship after review"]] },
    );
  });

  it("rejects a question through the normal deny action", async () => {
    const user = userEvent.setup();
    renderQuestionCard();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(respondToApproval).toHaveBeenCalledWith("que_1", { choiceId: "deny" });
  });

  it("keeps same-index radio answers independent across simultaneous cards", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PermissionRequestCard request={{ ...createMockApproval({ requestId: "que_1", subject: { kind: "question", questions } }), settled: false }} />
        <PermissionRequestCard request={{ ...createMockApproval({ requestId: "que_2", subject: { kind: "question", questions } }), settled: false }} />
      </>,
    );
    const yesOptions = screen.getAllByRole("radio", { name: "Yes" });
    await waitFor(() => expect(yesOptions.every((option) => !option.hasAttribute("disabled"))).toBe(true));

    await user.click(yesOptions[0]!);
    await user.click(yesOptions[1]!);

    expect(yesOptions[0]).toBeChecked();
    expect(yesOptions[1]).toBeChecked();
  });
});

describe("PermissionRequestCard provider-native options", () => {
  beforeEach(() => {
    respondToApproval.mockClear();
  });

  it("renders provider options verbatim and responds with the selected optionId", async () => {
    const user = userEvent.setup();
    render(
      <PermissionRequestCard
        request={{ ...createMockApproval({ requestId: "req-1", choices: [
          { id: "allow_once", label: "Allow once", intent: "allow_once" },
          { id: "reject_once", label: "Reject", intent: "deny" },
        ] }), settled: false }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Reject" }));

    expect(respondToApproval).toHaveBeenCalledWith("req-1", { choiceId: "reject_once" });
  });

  it("shows a failed acknowledgement and leaves the advertised choices retryable", async () => {
    respondToApproval.mockResolvedValueOnce({ status: "failed", message: "offline" });
    const user = userEvent.setup();
    render(
      <PermissionRequestCard
        request={{ ...createMockApproval({ requestId: "req-2" }), settled: false }}
      />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow once" })).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(respondToApproval).toHaveBeenCalledWith("req-2", { choiceId: "deny" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to send response");
    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(respondToApproval.mock.calls).toEqual([["req-2", { choiceId: "deny" }], ["req-2", { choiceId: "deny" }]]);
  });
});
