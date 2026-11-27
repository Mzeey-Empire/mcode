import type { WorkspaceMoveFrame, WorkspaceMoveResult } from "@mcode/contracts/ws/workspace-move";
import { describe, expect, it } from "vitest";
import { describeFieldRefusal } from "../new-project-fields";
import { FORM_RUN, followedOperation, newProjectRunReducer, type NewProjectRun, type NewProjectRunAction } from "../new-project-run";

function frame(revision: number, result?: WorkspaceMoveResult, operationId = "op-1"): WorkspaceMoveFrame {
  return { operationId, revision, phase: result ? "done" : "renamed", copiedBytes: null, totalBytes: null, ...(result ? { result } : {}) };
}

function run(...actions: NewProjectRunAction[]): NewProjectRun {
  return actions.reduce(newProjectRunReducer, FORM_RUN);
}

const STARTED: NewProjectRunAction[] = [{ type: "submitted" }, { type: "started", operationId: "op-1" }];

describe("newProjectRunReducer", () => {
  it("follows no operation until the server names one", () => {
    expect(followedOperation(run({ type: "submitted" }))).toBeNull();
    expect(followedOperation(run(...STARTED))).toBe("op-1");
  });

  it("keeps the higher revision when two reads of one operation arrive out of order", () => {
    const ended = run(...STARTED, { type: "frame", frame: frame(3, { status: "failed", error: "EBUSY" }) });
    const afterOlder = newProjectRunReducer(ended, { type: "frame", frame: frame(1) });

    expect(afterOlder).toEqual({ kind: "failed", error: "EBUSY", outcome: "rolled-back" });
  });

  it("does not let a running frame replace a newer running one", () => {
    const afterTwo = run(...STARTED, { type: "frame", frame: frame(2) }, { type: "frame", frame: frame(1) });

    expect(afterTwo).toEqual({ kind: "moving", operationId: "op-1", revision: 2 });
  });

  it("ignores frames of an operation the run does not follow", () => {
    const before = run(...STARTED);

    expect(newProjectRunReducer(before, { type: "frame", frame: frame(5, { status: "created", workspaceId: "ws" }, "op-2") })).toBe(before);
  });

  it("adopts a finished move found at open, and only from the form", () => {
    const created = frame(4, { status: "created", workspaceId: "ws-1" });

    expect(run({ type: "adopted", frame: created })).toEqual({ kind: "created", workspaceId: "ws-1" });
    const moving = run(...STARTED);
    expect(newProjectRunReducer(moving, { type: "adopted", frame: created })).toBe(moving);
  });

  it.each([
    ["a Windows marker path", "D:\\.mcode\\no-project\\a\\.mcode-move.json", "D:\\.mcode\\no-project\\a"],
    ["a POSIX marker path", "/home/.mcode/no-project/a/.mcode-move.json", "/home/.mcode/no-project/a"],
    ["no recorded marker", null, null],
  ])("reports the folder that holds the files from %s", (_name, markerPath, folder) => {
    const pending = run(...STARTED, { type: "frame", frame: frame(2, { status: "rollback-pending", error: "EPERM", markerPath }) });

    expect(pending).toMatchObject({ kind: "rollback-pending", error: "EPERM", folder });
  });

  it("keeps a failed git retry on the alert with the new reason, and ends it on success", () => {
    const gitFailed = run(...STARTED, { type: "frame", frame: frame(3, { status: "git-failed", workspaceId: "ws-1", error: "first" }) });

    const retrying = newProjectRunReducer(gitFailed, { type: "git-retrying" });
    expect(retrying).toMatchObject({ kind: "git-failed", retrying: true });
    const stillFailed = newProjectRunReducer(retrying, { type: "git-retried", result: { status: "git-failed", workspaceId: "ws-1", error: "second" } });
    expect(stillFailed).toMatchObject({ kind: "git-failed", error: "second", retrying: false });
    expect(newProjectRunReducer(stillFailed, { type: "git-retried", result: { status: "created", workspaceId: "ws-1" } })).toEqual({ kind: "created", workspaceId: "ws-1" });
  });

  it("leaves a move that is running alone when the user picks another destination", () => {
    const moving = run(...STARTED);

    expect(newProjectRunReducer(moving, { type: "reset" })).toBe(moving);
    expect(newProjectRunReducer(run({ type: "failed", error: "x", outcome: "rolled-back" }), { type: "reset" })).toBe(FORM_RUN);
  });
});

describe("describeFieldRefusal", () => {
  const values = { name: "notes", location: "~/src" };

  it("leaves a refusal that is not about one field to the failed-move notice", () => {
    expect(describeFieldRefusal("The thread has no managed No project folder", values)).toBeNull();
  });

  it("words a taken folder with the path the user would read", () => {
    expect(describeFieldRefusal("Project destination already exists", { name: "notes", location: " D:\\work " })).toEqual({
      field: "name",
      message: "D:\\work\\notes already exists. Choose another name or location.",
    });
  });
});
