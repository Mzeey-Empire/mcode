import { mockTransport } from "@/__tests__/mocks/transport";
import type { ThreadStartup } from "@mcode/contracts/thread-startup";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startupTransport = {
  resolveThreadStartup: vi.mocked(mockTransport.resolveThreadStartup),
};

vi.mock("@/transport", () => ({
  getTransport: () => mockTransport,
}));

beforeEach(() => {
  vi.mocked(mockTransport.resolveThreadStartup).mockReset();
});

import { useToastStore } from "@/stores/toastStore";
import { OriginFetchActions } from "../OriginFetchActions";
import { useThreadStartupStore } from "../state/thread-startup-store";
import { useStartupFetchDecision } from "../useStartupActions";

const startupId = "00000000-0000-4000-8000-000000000002";
const T0 = "2026-09-02T12:00:00.000Z";

const fetchBlocked: ThreadStartup = {
  startupId,
  workspaceId: "workspace-1",
  kind: "managed-worktree",
  state: "blocked",
  phase: "fetch",
  steps: [
    { phase: "fetch", state: "running", startedAt: T0, detail: { phase: "fetch", ref: "origin/main", branch: "main" } },
    { phase: "thread", state: "pending" },
    { phase: "worktree", state: "pending" },
    { phase: "setup", state: "pending" },
    { phase: "agent", state: "pending" },
  ],
  transcript: [],
  cancellation: "none",
  revision: 1,
  createdAt: T0,
  updatedAt: T0,
  block: { code: "start_from_origin_failed", message: "Could not fetch origin/main", actions: ["retry", "continue"] },
};

function BlockedTrailActions({ startup }: { readonly startup: ThreadStartup }) {
  const decision = useStartupFetchDecision(startup);
  return decision ? <OriginFetchActions decision={decision} /> : null;
}

describe("OriginFetchActions", () => {
  beforeEach(() => {
    startupTransport.resolveThreadStartup.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("retries, then applies the server's answer and re-enables both actions", async () => {
    const answered = { ...fetchBlocked, revision: 2 };
    startupTransport.resolveThreadStartup.mockResolvedValue(answered);
    const apply = vi.spyOn(useThreadStartupStore.getState(), "apply");
    render(<BlockedTrailActions startup={fetchBlocked} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(startupTransport.resolveThreadStartup).toHaveBeenCalledWith(startupId, "retry");
    expect(screen.getByRole("button", { name: "Start from local main" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled());
    expect(apply).toHaveBeenCalledWith(answered);
  });

  it("reports a rejected Continue and lets the user choose again", async () => {
    startupTransport.resolveThreadStartup.mockRejectedValue(new Error("socket closed"));
    render(<BlockedTrailActions startup={fetchBlocked} />);

    fireEvent.click(screen.getByRole("button", { name: "Start from local main" }));

    expect(startupTransport.resolveThreadStartup).toHaveBeenCalledWith(startupId, "continue");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Start from local main" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(useToastStore.getState().toasts).toMatchObject([
      { kind: "failed", title: "Could not start from local main", meta: "socket closed" },
    ]);
  });

  it("names the local branch from the fetch ref when the detail carries no branch", () => {
    const releaseBlocked: ThreadStartup = {
      ...fetchBlocked,
      steps: fetchBlocked.steps.map((step) =>
        step.phase === "fetch" ? { ...step, detail: { phase: "fetch", ref: "origin/release/2.0" } } : step),
    };
    render(<BlockedTrailActions startup={releaseBlocked} />);

    expect(screen.getByRole("button", { name: "Start from local release/2.0" })).toBeInTheDocument();
  });
});
