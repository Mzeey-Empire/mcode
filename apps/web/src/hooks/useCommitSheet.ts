import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommitParams, GitCommitRejection, GitCommitResult } from "@mcode/contracts/git-commit";
import type { ReviewFileChange } from "@mcode/contracts/models/review-comparison";
import { getTransport } from "@/transport";
import { RpcError } from "@/transport/ws-transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  checkedFiles,
  toCommitFiles,
  withChecked,
  type CommitChoices,
} from "@/lib/commit-selection";

/** How often a pending push is re-read; replaying a `requestId` is free because the server answers from its record. */
export const PUSH_POLL_INTERVAL_MS = 1000;

/** Where the commit request stands. `committing`, `pushing` and `interrupted` lock the file list and message. */
export type CommitSubmission =
  | { readonly kind: "idle" }
  | { readonly kind: "committing" }
  | { readonly kind: "pushing"; readonly shortSha: string }
  /** The connection dropped mid-request. The same `requestId` is resent once it returns. */
  | { readonly kind: "interrupted" }
  | { readonly kind: "rejected"; readonly reason: GitCommitRejection }
  | { readonly kind: "unknown"; readonly head: string | null; readonly detail: string }
  | { readonly kind: "push-failed"; readonly shortSha: string; readonly summary: string; readonly detail: string };

export type MessageGeneration =
  | { readonly kind: "idle" }
  | { readonly kind: "writing" }
  | { readonly kind: "written"; readonly modelName: string }
  | { readonly kind: "failed"; readonly message: string };

export interface CommitDraft {
  readonly subject: string;
  readonly body: string;
}

export interface UseCommitSheetOptions {
  readonly workspaceId: string;
  readonly threadId: string | null;
  /** Review's scope id (thread, else workspace); a settled commit bumps its `diffRevision`. */
  readonly scopeId: string;
  /** HEAD the list was built from; `null` is unborn, `undefined` is not loaded yet. */
  readonly head: string | null | undefined;
  /** Every uncommitted file, or `null` until the list loads. */
  readonly files: readonly ReviewFileChange[] | null;
  /** Called after a commit settles with nothing left to show in the sheet. */
  readonly onDone: () => void;
}

export interface CommitSheetModel {
  readonly choices: CommitChoices;
  readonly setChecked: (files: readonly ReviewFileChange[], checked: boolean) => void;
  readonly selected: readonly ReviewFileChange[];
  readonly draft: CommitDraft;
  readonly setDraft: (draft: CommitDraft) => void;
  readonly generation: MessageGeneration;
  readonly regenerate: () => void;
  readonly submission: CommitSubmission;
  readonly submit: (push: boolean) => void;
  readonly retry: () => void;
  readonly canCommit: boolean;
}

/** True while a commit request is outstanding, including a pending push and a resend awaiting the connection. */
export function isRequestInFlight(submission: CommitSubmission): boolean {
  return submission.kind === "committing" || submission.kind === "pushing" || submission.kind === "interrupted";
}

function isPendingPush(result: GitCommitResult): result is Extract<GitCommitResult, { status: "committed" }> {
  return result.status === "committed" && result.push.status === "pending";
}

/** Runs `resend` once, the next time the connection comes back. */
function resendOnReconnect(resend: () => void): void {
  const unsubscribe = useConnectionStore.subscribe((state) => {
    if (state.status !== "connected") return;
    unsubscribe();
    resend();
  });
}

/** Subject, then a blank line and the body when there is one. */
export function composeMessage({ subject, body }: CommitDraft): string {
  return [subject.trim(), body.trim()].filter(Boolean).join("\n\n");
}

/**
 * State machine behind the Commit sheet: the user's checkbox choices, the generated
 * message, and one durable commit request.
 *
 * A request keeps its `requestId` and frozen params until the server returns a settled
 * result, so a dropped connection resends exactly what was sent and the server replays
 * its stored outcome instead of committing twice. A rejection is also a settled result
 * (a replay would return the same rejection), so the next click builds a new request.
 */
export function useCommitSheet(options: UseCommitSheetOptions): CommitSheetModel {
  const { workspaceId, threadId, scopeId, head, files, onDone } = options;
  const [choices, setChoices] = useState<CommitChoices>(new Map());
  const [draft, setDraft] = useState<CommitDraft>({ subject: "", body: "" });
  const [generation, setGeneration] = useState<MessageGeneration>({ kind: "idle" });
  const [submission, setSubmission] = useState<CommitSubmission>({ kind: "idle" });
  const connection = useConnectionStore((state) => state.status);
  const request = useRef<GitCommitParams | null>(null);
  const lifeRef = useRef<{ alive: boolean; generation: number; poll: ReturnType<typeof setTimeout> | null }>({
    alive: true,
    generation: 0,
    poll: null,
  });
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const submissionRef = useRef(submission);
  submissionRef.current = submission;
  const sendRef = useRef<(params: GitCommitParams) => void>(() => {});

  const selected = useMemo(() => (files ? checkedFiles(files, choices) : []), [files, choices]);

  const generate = useCallback(
    (paths: readonly string[]) => {
      const token = ++lifeRef.current.generation;
      setGeneration({ kind: "writing" });
      getTransport()
        .generateCommitMessage({ workspaceId, threadId: threadId ?? undefined, paths: [...paths] })
        .then(
          (result) => {
            if (token !== lifeRef.current.generation) return;
            if (result.status === "ok") {
              setDraft({ subject: result.subject, body: result.body });
              setGeneration({ kind: "written", modelName: result.model.name });
            } else {
              setGeneration({ kind: "failed", message: result.message });
            }
          },
          (error: unknown) => {
            if (token !== lifeRef.current.generation) return;
            setGeneration({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
          },
        );
    },
    [workspaceId, threadId],
  );

  const generatedOnOpen = useRef(false);
  useEffect(() => {
    if (generatedOnOpen.current || selected.length === 0) return;
    generatedOnOpen.current = true;
    generate(selected.map((file) => file.path));
  }, [selected, generate]);

  const regenerate = useCallback(() => {
    if (selected.length > 0) generate(selected.map((file) => file.path));
  }, [selected, generate]);

  const settle = useCallback(
    (result: GitCommitResult) => {
      request.current = null;
      useDiffStore.getState().bumpDiffRevision(scopeId);
      if (result.status === "rejected") return setSubmission({ kind: "rejected", reason: result.reason });
      if (result.status === "unknown") return setSubmission({ kind: "unknown", head: result.head, detail: result.detail });
      if (result.push.status === "failed") {
        return setSubmission({
          kind: "push-failed",
          shortSha: result.shortSha,
          summary: result.push.summary,
          detail: result.push.detail,
        });
      }
      setSubmission({ kind: "idle" });
      onDoneRef.current();
    },
    [scopeId],
  );

  const settleFailure = useCallback(
    (error: Error) => {
      request.current = null;
      setSubmission({ kind: "rejected", reason: { kind: "failed", summary: "Couldn't commit", detail: error.message } });
    },
    [],
  );

  const send = useCallback(
    (params: GitCommitParams) => {
      getTransport()
        .commitChanges(params)
        .then(
          (result) => {
            if (!lifeRef.current.alive) {
              if (!isPendingPush(result)) useDiffStore.getState().bumpDiffRevision(scopeId);
              return;
            }
            if (isPendingPush(result)) {
              setSubmission({ kind: "pushing", shortSha: result.shortSha });
              lifeRef.current.poll = setTimeout(() => send(params), PUSH_POLL_INTERVAL_MS);
              return;
            }
            settle(result);
          },
          (error: unknown) => {
            if (!lifeRef.current.alive) {
              // The user left the thread mid-drop. Finish the request anyway so its result is
              // recorded and Review refreshes, instead of leaving the outcome unread.
              if (!(error instanceof RpcError)) resendOnReconnect(() => send(params));
              return;
            }
            // A server error answers the request, so resending the same params would only fail again.
            if (error instanceof RpcError) return settleFailure(error);
            setSubmission({ kind: "interrupted" });
          },
        );
    },
    [settle, settleFailure, scopeId],
  );

  sendRef.current = send;

  const submit = useCallback(
    (push: boolean) => {
      if (head === undefined || selected.length === 0 || composeMessage(draft) === "") return;
      const params: GitCommitParams = {
        workspaceId,
        threadId: threadId ?? undefined,
        requestId: crypto.randomUUID(),
        expectedHead: head,
        files: toCommitFiles(selected),
        message: composeMessage(draft),
        push,
      };
      request.current = params;
      setSubmission({ kind: "committing" });
      send(params);
    },
    [head, selected, draft, workspaceId, threadId, send],
  );

  const retry = useCallback(() => {
    if (!request.current) return;
    setSubmission({ kind: "committing" });
    send(request.current);
  }, [send]);

  // The server answers a known requestId from its record, so resending cannot commit twice.
  useEffect(() => {
    if (submission.kind === "interrupted" && connection === "connected") retry();
  }, [submission.kind, connection, retry]);

  useEffect(() => {
    const life = lifeRef.current;
    life.alive = true;
    return () => {
      life.alive = false;
      life.generation++;
      if (life.poll) clearTimeout(life.poll);
      // An already-dropped request has no promise left to hand off, so resume it here.
      const params = request.current;
      if (params && submissionRef.current.kind === "interrupted") {
        const resend = () => sendRef.current(params);
        if (useConnectionStore.getState().status === "connected") resend();
        else resendOnReconnect(resend);
      }
    };
  }, []);

  const busy = isRequestInFlight(submission);
  const canCommit =
    head !== undefined &&
    selected.length > 0 &&
    composeMessage(draft) !== "" &&
    generation.kind !== "writing" &&
    !busy &&
    submission.kind !== "unknown" &&
    submission.kind !== "push-failed";

  return {
    choices,
    setChecked: (targets, checked) => setChoices((current) => withChecked(current, targets, checked)),
    selected,
    draft,
    setDraft,
    generation,
    regenerate,
    submission,
    submit,
    retry,
    canCommit,
  };
}
