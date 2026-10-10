import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanVersion } from "@mcode/contracts";
import { usePlanStore } from "@/stores/planStore";
import { PlanChrome } from "./PlanChrome";

const plan: PlanVersion = {
  id: "plan-1",
  threadId: "t1",
  messageId: "00000000-0000-4000-8000-000000000001",
  version: 1,
  title: "A Plan",
  contentMd: "## Step\n\nDo it.",
  author: "agent", providerId: "codex", captureSource: "fence", baseVersionId: null,
  revision: 0, acceptedAt: null, acceptedMessageId: null, updatedAt: "2026-06-03T00:00:01.000Z",
  status: "ready",
  createdAt: "2026-06-03T00:00:01.000Z",
};

beforeEach(() => {
  usePlanStore.setState({ plansByThread: {}, activeVersionByThread: {}, generatingThreads: new Set() });
  vi.clearAllMocks();
});

describe("PlanChrome Implement button", () => {
  it("always renders Implement as the solid primary action", () => {
    render(
      <PlanChrome
        plan={plan}
        allVersions={[plan]}
        threadId="t1"
        onRevise={() => {}}
        onImplement={() => {}}
        commentCount={0}
      />,
    );
    const implement = screen.getByRole("button", { name: /implement/i });
    expect(implement).toBeInTheDocument();
    // Solid amber primary fill carries the emphasis; no pulsing glow.
    expect(implement.className).toContain("bg-primary");
    expect(implement.className).not.toContain("animate-plan-implement-glow");
  });

  it("lists every revision and selects an older one", async () => {
    const v1: PlanVersion = { ...plan, id: "p1", version: 1, status: "superseded", createdAt: "2026-06-04T11:40:00.000Z" };
    const v2: PlanVersion = { ...plan, id: "p2", version: 2, status: "superseded", createdAt: "2026-06-04T11:54:00.000Z" };
    const v3: PlanVersion = { ...plan, id: "p3", version: 3, status: "ready", createdAt: "2026-06-04T12:00:00.000Z" };
    usePlanStore.setState({ plansByThread: { t1: [v1, v2, v3] } });

    render(
      <PlanChrome plan={v3} allVersions={[v1, v2, v3]} threadId="t1" onRevise={() => {}} onImplement={() => {}} commentCount={0} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /v3/i }));
    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();

    fireEvent.click(screen.getByText("v1"));
    await waitFor(() => expect(usePlanStore.getState().activeVersionByThread.t1).toBe(1));
  });
});
