import { useEffect, useReducer } from "react";
import { WS_CHANNELS } from "@mcode/contracts/ws/channels";
import type { WorkspaceMoveFrame } from "@mcode/contracts/ws/workspace-move";
import { getTransport, pushEmitter } from "@/transport";
import { rpcFailureMessage } from "@/transport/rpc-failure-message";
import { describeFieldRefusal, type NewProjectValues } from "./new-project-fields";
import { FORM_RUN, followedOperation, newProjectRunReducer, type NewProjectRun, type NewProjectRunAction } from "./new-project-run";

function subscribeToMoveFrames(onFrame: (frame: WorkspaceMoveFrame) => void): () => void {
  return pushEmitter.on("workspace.move.progress", (data) => {
    const parsed = WS_CHANNELS["workspace.move.progress"].safeParse(data);
    if (parsed.success) onFrame(parsed.data);
  });
}

const STATUS_READ_ATTEMPTS = 3;
const STATUS_READ_BACKOFF_MS = 500;

/**
 * Reads the operation's status, trying again after a failure. The read is the catch-up for a terminal frame that was
 * pushed before the subscription existed, so when every attempt fails the move may have ended with no frame to come.
 * Returns the cancel function for the effect's cleanup.
 */
function readStatusWithRetry(
  operationId: string,
  onFrame: (frame: WorkspaceMoveFrame) => void,
  onGaveUp: () => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (number: number) => {
    getTransport().readWorkspaceMoveStatus({ operationId }).then(
      (frame) => { if (!cancelled && frame) onFrame(frame); },
      () => {
        if (cancelled) return;
        if (number >= STATUS_READ_ATTEMPTS) onGaveUp();
        else timer = setTimeout(() => attempt(number + 1), STATUS_READ_BACKOFF_MS * number);
      },
    );
  };
  attempt(1);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

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
    let heardFrame = false;
    const stop = subscribeToMoveFrames((frame) => {
      if (frame.operationId !== operationId) return;
      heardFrame = true;
      dispatch({ type: "frame", frame });
    });
    const stopReading = readStatusWithRetry(
      operationId,
      (frame) => dispatch({ type: "frame", frame }),
      // A frame that arrived shows the pushes work, so the move is still followed and the read is not needed.
      () => { if (!heardFrame) dispatch({ type: "result-unreadable", operationId }); },
    );
    return () => {
      stopReading();
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
    return { type: "failed", error: rpcFailureMessage(error), outcome: "unconfirmed" };
  }
}
