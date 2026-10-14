import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommitParams, GitCommitRejection, GitCommitResult, ReviewFileChange } from "@mcode/contracts";
import { getTransport } from "@/transport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDiffStore } from "@/stores/diffStore";
import {
  checkedFiles,
  toCommitFiles,
  withChecked,
  type CommitChoices,
} from "@/lib/commit-selection";

/** How often a pending push's outcome is re-read. Replaying the `requestId` is free; the server answers from its record. */
export const PUSH_POLL_INTERVAL_MS = 1000;

/** Where the commit request stands. Everything except `idle` locks the file list and message. */
export type CommitSubmission =
  | { readonly kind: "idle" }
  | { readonly kind: "committing" }
  | { readonly kind: "pushing"; readonly shortSha: string }
  /** The connection dropped mid-request. The same `requestId` is resent once it returns. */
  | { readonly kind: "interrupted" }
  | { readonly kind: "rejected"; readonly reason: GitCommitRejection }
  | { readonly kind: "unknown"; readonly head: string | null; readonly detail: string }
  | { readonly kind: "push-failed"; readonly shortSha: string; readonly summary: string; readonly detail: string };

/** Progress of the generated message. */
export type MessageGeneration =
  | { readonly kind: "idle" }
  | { readonly kind: "writing" }
  | { readonly kind: "written"; readonly modelName: string }
  | { readonly kind: "failed"; readonly message: string };

/** The editable commit message. */
export interface CommitDraft {
  readonly subject: string;
  readonly body: string;
}

/** Inputs for {@link useCommitSheet}. */
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

/** What {@link useCommitSheet} exposes to the sheet. */
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
  const [choices, setChoices] = useState<CommitChoices>({});
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

  // Generate once when the list first loads with something checked; later only on regenerate.
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

  const send = useCallback(
    (params: GitCommitParams) => {
      getTransport()
        .commitChanges(params)
        .then(
          (result) => {
            if (!lifeRef.current.alive) return;
            if (result.status === "committed" && result.push.status === "pending") {
              setSubmission({ kind: "pushing", shortSha: result.shortSha });
              lifeRef.current.poll = setTimeout(() => send(params), PUSH_POLL_INTERVAL_MS);
              return;
            }
            settle(result);
          },
          () => {
            if (lifeRef.current.alive) setSubmission({ kind: "interrupted" });
          },
        );
    },
    [settle],
  );

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

  // Resend the frozen request once the socket is back; the server answers a known requestId from its record.
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
    };
  }, []);

  const busy = submission.kind === "committing" || submission.kind === "pushing" || submission.kind === "interrupted";
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
