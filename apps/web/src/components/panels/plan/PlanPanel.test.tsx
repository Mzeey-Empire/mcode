import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { PlanVersion } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { PlanPanel } from "./PlanPanel";

const THREAD = "thread-plan";

function makePlan(version: number, overrides: Partial<PlanVersion> = {}): PlanVersion {
  return {
    id: `plan-${version}`,
    threadId: THREAD,
    messageId: `message-${version}`,
    version,
    title: `Version ${version} Plan`,
    contentMd: `# Version ${version} Plan\n\nSummary ${version}.\n\n## Steps\n\n1. Step for v${version}\n`,
    author: "agent",
    providerId: "codex",
    captureSource: "fence",
    baseVersionId: null,
    revision: 0,
    acceptedAt: null,
    acceptedMessageId: null,
    status: "ready",
    createdAt: `2026-05-23T00:00:0${version}.000Z`,
    updatedAt: `2026-05-23T00:00:0${version}.000Z`,
    ...overrides,
  };
}

function editorText(): string {
  return document.querySelector(".cm-content")?.textContent ?? "";
}

describe("PlanPanel", () => {
  beforeEach(() => {
    usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {} });
  });

  it("shows the latest version and names it in the picker", () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "superseded" }), makePlan(2)] },
    });

    render(<PlanPanel threadId={THREAD} />);

    expect(editorText()).toContain("Version 2 Plan");
    expect(editorText()).toContain("Step for v2");
    expect(editorText()).not.toContain("#");
    expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v2Codex");
  });

  it("shows an older version's content after it is picked", async () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "superseded" }), makePlan(2)] },
    });
    render(<PlanPanel threadId={THREAD} />);
    const user = userEvent.setup();

    await user.click(screen.getByTestId("plan-version-picker"));
    const rows = await screen.findAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual(["v2 Codex", "v1 Older version"]);
    await user.click(screen.getByRole("menuitemradio", { name: "v1 Older version" }));

    expect(usePlanStore.getState().activeVersionByThread[THREAD]).toBe(1);
    await waitFor(() => expect(editorText()).toContain("Step for v1"));
    expect(editorText()).not.toContain("Step for v2");
    expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v1Older version");
  });

  it("reads Accepted for an accepted version and offers no Implement action", () => {
    usePlanStore.setState({
      plansByThread: { [THREAD]: [makePlan(1, { status: "accepted", acceptedAt: "2026-05-24T00:00:00.000Z" })] },
    });

    render(<PlanPanel threadId={THREAD} />);

    expect(screen.getByTestId("plan-version-picker")).toHaveTextContent("v1Accepted");
    expect(screen.queryByRole("button", { name: /implement/i })).toBeNull();
  });

  it("renders nothing when the thread has no plan", () => {
    const { container } = render(<PlanPanel threadId={THREAD} />);

    expect(container).toBeEmptyDOMElement();
  });
});
