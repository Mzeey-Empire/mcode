import { useEffect, useReducer } from "react";
import { WS_CHANNELS } from "@mcode/contracts/ws/channels";
import type { WorkspaceMoveFrame } from "@mcode/contracts/ws/workspace-move";
import { getTransport, pushEmitter } from "@/transport";
import { rpcFailureMessage } from "@/transport/rpc-failure-message";
import { describeFieldRefusal, type NewProjectValues } from "./new-project-fields";
import { FORM_RUN, followedOperation, newProjectRunReducer, type NewProjectRun, type NewProjectRunAction } from "./new-project-run";

/** Calls `onFrame` for every progress frame the server pushes, until the returned function runs. */
function subscribeToMoveFrames(onFrame: (frame: WorkspaceMoveFrame) => void): () => void {
  return pushEmitter.on("workspace.move.progress", (data) => {
    const parsed = WS_CHANNELS["workspace.move.progress"].safeParse(data);
    if (parsed.success) onFrame(parsed.data);
  });
}

/** What the dialog can do about a new-project move. */
export interface NewProjectRunControls {
  readonly run: NewProjectRun;
  /** Asks the server to turn the folder into a project. Also what Try again runs. */
  readonly create: (values: NewProjectValues, initGit: boolean) => void;
  /** Runs git init again on a project that was created without it. */
  readonly retryGit: () => void;
  /** Leaves a failed attempt behind, for a user who picked another destination. */
  readonly reset: () => void;
}

/**
 * A new-project move from the click to its end, for the thread the dialog is open on. The dialog opens on a
 * thread whose move already runs, so it first looks for one by thread id.
 *
 * Two reads of one operation can disagree about whether it finished: a frame the server pushed and the status the
 * client asked for. Each is listened for before the other is read, and the run keeps whichever has the higher
 * revision, so a move that ends between the two still shows its result.
 */
export function useNewProjectRun(threadId: string): NewProjectRunControls {
  const [run, dispatch] = useReducer(newProjectRunReducer, FORM_RUN);

  useEffect(() => {
    let current = true;
    getTransport().readWorkspaceMoveStatus({ threadId }).then(
      (frame) => { if (current && frame) dispatch({ type: "adopted", frame }); },
      // No unfinished move is the common case, and a failed read leaves the form, which the server then refuses
      // with its own reason if a move does run.
      () => {},
    );
    return () => { current = false; };
  }, [threadId]);

  const operationId = followedOperation(run);
  useEffect(() => {
    if (operationId === null) return;
    let current = true;
    const stop = subscribeToMoveFrames((frame) => {
      if (frame.operationId === operationId) dispatch({ type: "frame", frame });
    });
    getTransport().readWorkspaceMoveStatus({ operationId }).then(
      (frame) => { if (current && frame) dispatch({ type: "frame", frame }); },
      // The pushed frames still arrive, so a failed read only loses the catch-up for a frame that already passed.
      () => {},
    );
    return () => {
      current = false;
      stop();
    };
  }, [operationId]);

  const create = (values: NewProjectValues, initGit: boolean) => {
    dispatch({ type: "submitted" });
    void requestCreation(threadId, values, initGit).then(dispatch);
  };

  const retryGit = () => {
    if (run.kind !== "git-failed" || run.retrying) return;
    dispatch({ type: "git-retrying" });
    getTransport().retryWorkspaceMoveGit(run.operationId).then(
      (result) => dispatch({ type: "git-retried", result }),
      (error: unknown) => dispatch({ type: "git-retried", result: { status: "failed", error: rpcFailureMessage(error) } }),
    );
  };

  return { run, create, retryGit, reset: () => dispatch({ type: "reset" }) };
}

/** Sends the request and says what it did to the run. */
async function requestCreation(threadId: string, values: NewProjectValues, initGit: boolean): Promise<NewProjectRunAction> {
  try {
    const result = await getTransport().createProjectFromFolder({ threadId, name: values.name, parentPath: values.location.trim(), initGit });
    if ("operationId" in result) return { type: "started", operationId: result.operationId };
    if (result.status === "busy") return { type: "refused", refusal: { kind: "busy", threadId: result.threadId, reason: result.reason } };
    const problem = describeFieldRefusal(result.error, values);
    return problem
      ? { type: "refused", refusal: { kind: "field", problem, values } }
      : { type: "failed", error: result.error, outcome: "rolled-back" };
  } catch (error) {
    // A request that never answered may still have been accepted, so this cannot promise that nothing changed.
    return { type: "failed", error: rpcFailureMessage(error), outcome: "unconfirmed" };
  }
}
