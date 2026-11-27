import { useEffect, useReducer, useState } from "react";
import { WS_CHANNELS } from "@mcode/contracts/ws/channels";
import type { WorkspaceMoveFrame, WorkspaceMoveStatusInput } from "@mcode/contracts/ws/workspace-move";
import { useConnectionStore } from "@/stores/connectionStore";
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
  input: WorkspaceMoveStatusInput,
  onRead: (frame: WorkspaceMoveFrame | null) => void,
  onGaveUp: () => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = (number: number) => {
    getTransport().readWorkspaceMoveStatus(input).then(
      (frame) => { if (!cancelled) onRead(frame); },
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

/**
 * How many times the socket has come back after dropping. A move that ends while the socket is down pushes its last
 * frame to no one, so a follower must read the status again each time this changes.
 */
function useReconnectCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => useConnectionStore.subscribe((next, previous) => {
    if (next.status === "connected" && previous.status !== "connected") setCount((current) => current + 1);
  }), []);
  return count;
}

export interface NewProjectRunControls {
  readonly run: NewProjectRun;
  /**
   * Whether the look for an unfinished move has ended, with a move or without one. Until then the form must not send
   * a request: the server refuses it while that move runs, and the answer that says so would arrive late.
   */
  readonly lookedUp: boolean;
  /** Present after the lookup fails, while creation is still disabled. */
  readonly retryLookup: (() => void) | null;
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
 * revision, so a move that ends between the two still shows its result. The same listen-then-read runs again after
 * a reconnect, because the terminal frame may have been pushed while the socket was down.
 */
export function useNewProjectRun(threadId: string): NewProjectRunControls {
  const [run, dispatch] = useReducer(newProjectRunReducer, FORM_RUN);

  const [lookup, setLookup] = useState<{ threadId: string; status: "ready" | "failed" } | null>(null);
  const [lookupAttempt, retry] = useReducer((attempt: number) => attempt + 1, 0);
  useEffect(() => readStatusWithRetry(
    { threadId },
    (frame) => {
      if (frame) dispatch({ type: "adopted", frame });
      setLookup({ threadId, status: "ready" });
    },
    () => setLookup({ threadId, status: "failed" }),
  ), [threadId, lookupAttempt]);

  const operationId = followedOperation(run);
  const reconnects = useReconnectCount();
  useEffect(() => {
    if (operationId === null) return;
    let heardFrame = false;
    const stop = subscribeToMoveFrames((frame) => {
      if (frame.operationId !== operationId) return;
      heardFrame = true;
      dispatch({ type: "frame", frame });
    });
    const catchUp = () => readStatusWithRetry(
      { operationId },
      (frame) => { if (frame) dispatch({ type: "frame", frame }); },
      // A frame that arrived shows the pushes work, so the move is still followed and the read is not needed.
      () => { if (!heardFrame) dispatch({ type: "result-unreadable", operationId }); },
    );
    let stopReading = catchUp();
    const stopReconnect = useConnectionStore.subscribe((next, previous) => {
      if (next.status !== "connected" || previous.status === "connected") return;
      heardFrame = false;
      stopReading();
      stopReading = catchUp();
    });
    return () => {
      stopReconnect();
      stopReading();
      stop();
    };
  }, [operationId, reconnects]);

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

  const lookupStatus = lookup?.threadId === threadId ? lookup.status : null;
  return {
    run,
    lookedUp: lookupStatus === "ready",
    retryLookup: lookupStatus === "failed" ? () => { setLookup(null); retry(); } : null,
    create,
    retryGit,
    reset: () => dispatch({ type: "reset" }),
  };
}

async function requestCreation(threadId: string, values: NewProjectValues, initGit: boolean): Promise<NewProjectRunAction> {
  try {
    const result = await getTransport().createProjectFromFolder({ threadId, name: values.name, parentPath: values.location.trim(), initGit });
    if ("operationId" in result) return { type: "started", operationId: result.operationId };
    if (result.status === "busy") return { type: "refused", refusal: { kind: "busy", threadId: result.threadId, reason: result.reason } };
    const problem = describeFieldRefusal(result.error, values);
    return problem
      ? { type: "refused", refusal: { kind: "field", problem, values } }
      : { type: "failed", error: result.error, outcome: "rolled-back", cause: result.cause };
  } catch (error) {
    return { type: "failed", error: rpcFailureMessage(error), outcome: "unconfirmed" };
  }
}
