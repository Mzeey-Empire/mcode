import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getThreadStateMarker, ThreadStateMarker } from "@/components/sidebar/ThreadStateMarker";
import type { Thread } from "@/transport/types";
import { StatusMark } from "../status-mark";

type MarkerInput = Parameters<typeof getThreadStateMarker>[0];

const idleThread: Pick<Thread, "status" | "updated_at"> = { status: "active", updated_at: "2026-10-08T12:00:00.000Z" };

function markerInput(overrides: Partial<MarkerInput>): MarkerInput {
  return { thread: idleThread, checks: undefined, isRunning: false, hasPendingPermission: false, ...overrides };
}

describe("StatusMark", () => {
  it.each([
    ["running", "Running"],
    ["attention", "Action required"],
    ["success", "Completed"],
    ["error", "Failed"],
    ["info", "Info"],
  ] as const)("names the %s mark with its label", (state, label) => {
    render(<StatusMark state={state} label={label} />);

    const mark = screen.getByRole("img", { name: label });
    expect(mark).toHaveAttribute("data-status-mark", state);
    expect(mark).not.toHaveTextContent(/./);
  });
});

describe("ThreadStateMarker", () => {
  it.each([
    ["a running thread", markerInput({ isRunning: true }), "Running", "running"],
    ["a thread running setup", markerInput({ isSetupRunning: true }), "Setup running", "running"],
    ["a thread waiting on a permission", markerInput({ hasPendingPermission: true, isRunning: true }), "Action required", "attention"],
    ["a thread waiting on a setup response", markerInput({ isSetupAwaitingResponse: true }), "Awaiting response", "attention"],
    ["a finished thread", markerInput({ thread: { ...idleThread, status: "completed" } }), "Completed", "success"],
    ["a failed thread", markerInput({ thread: { ...idleThread, status: "errored" } }), "Failed", "error"],
    ["an interrupted thread", markerInput({ thread: { ...idleThread, status: "interrupted" } }), "Interrupted", "attention"],
  ] as const)("announces %s as %s", (_case, input, label, state) => {
    render(<ThreadStateMarker marker={getThreadStateMarker(input)} />);

    expect(screen.getByRole("img", { name: label })).toHaveAttribute("data-status-mark", state);
  });
});
