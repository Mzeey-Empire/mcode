import { describe, expect, it } from "vitest";
import { classifyCommitFailure, reconcilePrepared, settleCommit } from "../commits/commit-settlement.js";

const ORIGINAL = "a".repeat(40);
const NEXT = "b".repeat(40);

describe("settleCommit", () => {
  it("owns a root commit made from an unborn branch", () => {
    expect(settleCommit({
      exit: { kind: "exited", code: 0, output: "" },
      originalHead: null,
      currentHead: NEXT,
      currentHeadFirstParent: null,
    })).toEqual({ state: "committed", commitSha: NEXT });
  });

  it("does not own a commit on another parent even when git exited 0", () => {
    expect(settleCommit({
      exit: { kind: "exited", code: 0, output: "" },
      originalHead: ORIGINAL,
      currentHead: NEXT,
      currentHeadFirstParent: "c".repeat(40),
    })).toMatchObject({ state: "unknown", head: NEXT });
  });

  it("does not call a failure with a moved HEAD a rejection", () => {
    expect(settleCommit({
      exit: { kind: "killed", output: "" },
      originalHead: ORIGINAL,
      currentHead: NEXT,
      currentHeadFirstParent: ORIGINAL,
    })).toMatchObject({ state: "unknown", head: NEXT });
  });
});

describe("classifyCommitFailure", () => {
  it.each([
    ["nothing added to commit but untracked files present", { kind: "nothing-to-commit" }],
    ["*** Please tell me who you are.", { kind: "identity-missing" }],
    ["fatal: cannot do a partial commit during a merge.", { kind: "conflicts" }],
    ["fatal: Unable to create '/repo/.git/index.lock': File exists.", { kind: "index-locked" }],
    ["error: gpg failed to sign the data\nfatal: failed to write commit object", { kind: "failed", summary: "error: gpg failed to sign the data" }],
  ])("classifies %j", (output, expected) => {
    expect(classifyCommitFailure({ kind: "exited", code: 1, output })).toMatchObject(expected);
  });

  it("reports a killed commit as a timeout", () => {
    expect(classifyCommitFailure({ kind: "killed", output: "" }))
      .toMatchObject({ kind: "failed", summary: "Commit timed out after 300s" });
  });
});

describe("reconcilePrepared", () => {
  it("never settles an orphaned request as committed, whatever HEAD did", () => {
    const outcomes = [
      reconcilePrepared({ originalHead: ORIGINAL, currentHead: ORIGINAL, indexLockPresent: false }),
      reconcilePrepared({ originalHead: ORIGINAL, currentHead: ORIGINAL, indexLockPresent: true }),
      reconcilePrepared({ originalHead: ORIGINAL, currentHead: NEXT, indexLockPresent: false }),
    ];
    expect(outcomes.map((outcome) => outcome.state)).toEqual(["rejected", "unknown", "unknown"]);
  });
});
