import type { WorkspaceMoveFrame, WorkspaceMoveResult } from "@mcode/contracts/ws/workspace-move";
import { describe, expect, it } from "vitest";
import { describeFieldRefusal } from "../new-project-fields";
import { FORM_RUN, failureIsAboutLocation, followedOperation, followsMove, newProjectRunReducer, type NewProjectRun, type NewProjectRunAction } from "../new-project-run";

function frame(revision: number, result?: WorkspaceMoveResult, operationId = "op-1"): WorkspaceMoveFrame {
  return { operationId, revision, phase: result ? "done" : "renamed", copiedBytes: null, totalBytes: null, ...(result ? { result } : {}) };
}

function copyFrame(revision: number, phase: WorkspaceMoveFrame["phase"], bytes: { copied: number; total: number } | null): WorkspaceMoveFrame {
  return { operationId: "op-1", revision, phase, copiedBytes: bytes?.copied ?? null, totalBytes: bytes?.total ?? null };
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

    expect(afterOlder).toEqual({ kind: "failed", error: "EBUSY", outcome: "rolled-back", cause: { kind: "other" }, partialCopyRemoved: null });
  });

  it("does not let a running frame replace a newer running one", () => {
    const afterTwo = run(...STARTED, { type: "frame", frame: frame(2) }, { type: "frame", frame: frame(1) });

    expect(afterTwo).toEqual({ kind: "moving", operationId: "op-1", revision: 2, copy: null });
  });

  it("ignores frames of an operation the run does not follow", () => {
    const before = run(...STARTED);

    expect(newProjectRunReducer(before, { type: "frame", frame: frame(5, { status: "created", workspaceId: "ws" }, "op-2") })).toBe(before);
  });

  it("accepts the last known revision only while the result is unknown", () => {
    const unknownResult = run(
      ...STARTED,
      { type: "frame", frame: frame(7) },
      { type: "result-unreadable", operationId: "op-1" },
    );
    expect(newProjectRunReducer(unknownResult, { type: "frame", frame: frame(6) }))
      .toMatchObject({ kind: "result-unknown", operationId: "op-1", revision: 7 });

    const moving = newProjectRunReducer(unknownResult, { type: "frame", frame: frame(7) });
    expect(moving).toMatchObject({ kind: "moving", operationId: "op-1", revision: 7 });
    expect(newProjectRunReducer(moving, { type: "frame", frame: frame(7, { status: "created", workspaceId: "ws-1" }) }))
      .toMatchObject({ kind: "moving", operationId: "op-1", revision: 7 });
  });

  it("adopts a move found at open from whatever the run shows by then", () => {
    const created = frame(4, { status: "created", workspaceId: "ws-1" });

    expect(run({ type: "adopted", frame: created })).toEqual({ kind: "created", workspaceId: "ws-1" });
    expect(run({ type: "submitted" }, { type: "adopted", frame: frame(1) })).toEqual({ kind: "moving", operationId: "op-1", revision: 1 });
    expect(run({ type: "submitted" }, { type: "failed", error: "unfinished", outcome: "unconfirmed" }, { type: "adopted", frame: frame(1) }))
      .toEqual({ kind: "moving", operationId: "op-1", revision: 1 });
  });

  it("does not let an adopted frame replace a newer one of the operation the run follows", () => {
    const afterTwo = run(...STARTED, { type: "frame", frame: frame(2) });

    expect(newProjectRunReducer(afterTwo, { type: "adopted", frame: frame(1) })).toBe(afterTwo);
  });

  it.each([
    ["a Windows marker path", "D:\\.mcode\\no-project\\a\\.mcode-move.json", "D:\\.mcode\\no-project\\a"],
    ["a POSIX marker path", "/home/.mcode/no-project/a/.mcode-move.json", "/home/.mcode/no-project/a"],
    ["no recorded marker", null, null],
  ])("reports the folder that holds the files from %s", (_name, markerPath, folder) => {
    const pending = run(...STARTED, { type: "frame", frame: frame(2, { status: "rollback-pending", error: "EPERM", markerPath }) });

    expect(pending).toMatchObject({ kind: "rollback-pending", error: "EPERM", folder });
  });

  it("follows the copy's byte counts and keeps the bar full once the copy is whole", () => {
    const copying = run(...STARTED, { type: "frame", frame: copyFrame(2, "copying", { copied: 30, total: 100 }) });
    expect(copying).toMatchObject({ kind: "moving", copy: { copiedBytes: 30, totalBytes: 100 } });

    // The server stops sending counts after the last byte; the copy is whole, so the bar must not vanish.
    const published = newProjectRunReducer(copying, { type: "frame", frame: copyFrame(3, "published", null) });
    expect(published).toMatchObject({ kind: "moving", copy: { copiedBytes: 100, totalBytes: 100 } });
    expect(newProjectRunReducer(published, { type: "frame", frame: copyFrame(4, "converted", null) })).toMatchObject({ copy: { copiedBytes: 100, totalBytes: 100 } });
  });

  it("shows no copy for a same-drive move, whose frames never carry byte counts", () => {
    const renamed = run(...STARTED, { type: "frame", frame: copyFrame(2, "renamed", null) });
    const converted = newProjectRunReducer(renamed, { type: "frame", frame: copyFrame(3, "converted", null) });

    expect(converted).toMatchObject({ kind: "moving", copy: null });
  });

  it("has no total to fill when the dialog opens after the copy finished, so it shows no bar", () => {
    expect(run({ type: "adopted", frame: copyFrame(5, "published", null) })).toMatchObject({ kind: "moving", copy: null });
  });

  it("keeps the typed cause of every failure, and a copy only when the server says the move copied", () => {
    const copied = run(...STARTED, { type: "frame", frame: frame(3, { status: "failed", error: "ENOSPC", cause: { kind: "no-space", drive: "D:" }, partialCopyRemoved: true }) });
    const renamed = run(...STARTED, { type: "frame", frame: frame(3, { status: "failed", error: "EBUSY", cause: { kind: "in-use" } }) });

    expect(copied).toMatchObject({ kind: "failed", cause: { kind: "no-space", drive: "D:" }, partialCopyRemoved: true });
    expect(renamed).toMatchObject({ kind: "failed", cause: { kind: "in-use" }, partialCopyRemoved: null });
  });

  it("keeps a failed git retry on the alert with the new reason, and ends it on success", () => {
    const gitFailed = run(...STARTED, { type: "frame", frame: frame(3, { status: "git-failed", workspaceId: "ws-1", error: "first" }) });

    const retrying = newProjectRunReducer(gitFailed, { type: "git-retrying" });
    expect(retrying).toMatchObject({ kind: "git-failed", retrying: true });
    const stillFailed = newProjectRunReducer(retrying, { type: "git-retried", result: { status: "git-failed", workspaceId: "ws-1", error: "second" } });
    expect(stillFailed).toMatchObject({ kind: "git-failed", error: "second", retrying: false });
    expect(newProjectRunReducer(stillFailed, { type: "git-retried", result: { status: "created", workspaceId: "ws-1" } })).toEqual({ kind: "git-started", workspaceId: "ws-1" });
  });

  it("keeps the dialog open after a git retry works, because the thread has already left No project", () => {
    const started = newProjectRunReducer(
      run(...STARTED, { type: "frame", frame: frame(3, { status: "git-failed", workspaceId: "ws-1", error: "first" }) }),
      { type: "git-retried", result: { status: "created", workspaceId: "ws-1" } },
    );

    expect(followsMove(started)).toBe(true);
  });

  it("leaves a move that is running alone when the user picks another destination", () => {
    const moving = run(...STARTED);

    expect(newProjectRunReducer(moving, { type: "reset" })).toBe(moving);
    expect(newProjectRunReducer(run({ type: "failed", error: "x", outcome: "rolled-back", cause: { kind: "other" } }), { type: "reset" })).toBe(FORM_RUN);
  });
});

describe("failureIsAboutLocation", () => {
  const failed = (result: Extract<WorkspaceMoveResult, { status: "failed" }>) => {
    const ended = run(...STARTED, { type: "frame", frame: frame(3, result) });
    if (ended.kind !== "failed") throw new Error("the move did not fail");
    return ended;
  };

  it.each([
    ["a full drive with no copy", { status: "failed", error: "x", cause: { kind: "no-space", drive: "D:" } }, true],
    ["a refused write with no copy", { status: "failed", error: "x", cause: { kind: "permission" } }, true],
    ["an unknown failure with no copy", { status: "failed", error: "x", cause: { kind: "other" } }, false],
    ["an unknown failure of a copy", { status: "failed", error: "x", cause: { kind: "other" }, partialCopyRemoved: true }, true],
    ["a file in use with no copy", { status: "failed", error: "x", cause: { kind: "in-use" } }, false],
    ["a file in use during a copy", { status: "failed", error: "x", cause: { kind: "in-use" }, partialCopyRemoved: true }, false],
    ["a receipt written before typed causes", { status: "failed", error: "x" }, false],
  ] satisfies [string, Extract<WorkspaceMoveResult, { status: "failed" }>, boolean][])("tells %s", (_name, result, aboutLocation) => {
    expect(failureIsAboutLocation(failed(result))).toBe(aboutLocation);
  });

  it("says nothing about a field when the request never answered", () => {
    const unconfirmed = run({ type: "failed", error: "socket closed", outcome: "unconfirmed", cause: { kind: "permission" } });

    expect(unconfirmed.kind === "failed" && failureIsAboutLocation(unconfirmed)).toBe(false);
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
