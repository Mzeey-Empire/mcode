import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CircleAlert, CircleHelp, GitBranch, Pencil, Send, Shield, Terminal, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/shallow";
import type { ApprovalChoice, ApprovalSubject as ApprovalSubjectModel } from "@mcode/contracts";
import { ProviderIcon } from "@/components/ui/provider-icon";
import { useSubagentRoster } from "@/features/subagents/state/subagentRosterStore";
import { selectDockApprovals, useApprovalStore, type StoredApproval } from "@/stores/approvalStore";
import { approvalActorName, approvalTitle, noteRowLabel, submittingLabel } from "./approval-copy";
import { ApprovalChoiceRow, ApprovalNoteRow } from "./ApprovalChoiceRow";
import { ApprovalQuestionBody } from "./ApprovalQuestionBody";
import { ApprovalPager } from "./ApprovalPager";
import { ApprovalSubject } from "./ApprovalSubject";
import { DockStopButton } from "./DockStopButton";
import { submitApprovalChoice } from "./submit-approval-choice";
import { useDockFocus } from "./use-dock-focus";

/** Misclick guard: answers are ignored this long after the dock appears or the user was typing. */
export const APPROVAL_ARM_DELAY_MS = 600;

const SUBJECT_ICONS: Record<ApprovalSubjectModel["kind"], LucideIcon> = {
  command: Terminal,
  file_edit: Pencil,
  fetch: Shield,
  tool: Shield,
  thread_operation: Send,
  delegate_task: GitBranch,
  question: CircleHelp,
};

/** Titles of a Coordinator's Delegated threads, keyed by child thread id. */
export function useDelegatedThreadTitles(threadId: string | undefined): ReadonlyMap<string, string> {
  const roster = useSubagentRoster(threadId);
  return useMemo(() => new Map((roster?.entries ?? []).flatMap((entry) =>
    entry.childThreadId ? [[entry.childThreadId, entry.title] as const] : [])), [roster]);
}

/** Pending dock approvals for a thread and its Delegated threads, oldest first; empty means the composer shows. */
export function useDockApprovals(threadId: string | undefined, delegatedThreads: ReadonlyMap<string, string>): StoredApproval[] {
  const delegatedThreadIds = useMemo(() => new Set(delegatedThreads.keys()), [delegatedThreads]);
  return useApprovalStore(useShallow((state) => selectDockApprovals(state.approvals, threadId, delegatedThreadIds)));
}

/**
 * Keeps the user on the same request while others arrive or leave. When the shown
 * request leaves, the one that slid into its slot shows next, so deciding advances.
 */
function useActiveRequest(requests: readonly StoredApproval[]) {
  const [pagedId, setPagedId] = useState<string>();
  // The shown request is remembered by id, so an earlier request leaving does not shift the user onto another.
  const shownRef = useRef<{ requestId?: string; index: number }>({ index: 0 });
  const indexOf = (requestId: string | undefined) => requests.findIndex((request) => request.requestId === requestId);
  const index = [indexOf(pagedId), indexOf(shownRef.current.requestId)].find((found) => found >= 0)
    ?? Math.min(shownRef.current.index, requests.length - 1);
  shownRef.current = { requestId: requests[index]!.requestId, index };
  const page = (delta: number): string | undefined => {
    const target = requests[index + delta];
    if (target) setPagedId(target.requestId);
    return target?.requestId;
  };
  return { active: requests[index]!, index, page };
}

/** Focused row per request; switching requests starts again at the first row. */
function useFocusedRow(requestId: string) {
  const [focus, setFocus] = useState({ requestId, row: 0 });
  return [focus.requestId === requestId ? focus.row : 0, (row: number) => setFocus({ requestId, row })] as const;
}

type DockKeyAction = { readonly kind: "page" | "move" | "digit" | "arm"; readonly value: number };

const NAMED_KEYS: Readonly<Record<string, DockKeyAction>> = {
  "[": { kind: "page", value: -1 },
  "]": { kind: "page", value: 1 },
  ArrowUp: { kind: "move", value: -1 },
  ArrowDown: { kind: "move", value: 1 },
};

/**
 * Any other printable key means the user is typing, so it re-arms the misclick guard.
 * Enter and Space stay native: they click whichever button has focus, so a choice row
 * answers through its guarded click and Try again or Stop do their own job.
 */
function dockKeyAction(event: KeyboardEvent): DockKeyAction | undefined {
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  if (/^[1-9]$/.test(event.key)) return { kind: "digit", value: Number(event.key) - 1 };
  return event.key.length === 1 && event.key !== " " ? { kind: "arm", value: 0 } : undefined;
}

/** A text field owns its keys except the arrows, so a typed note can contain digits and brackets. */
function textFieldOwnsKey(action: DockKeyAction, event: KeyboardEvent): boolean {
  return event.target instanceof HTMLInputElement && action.kind !== "move";
}

/** A question body owns its keys, except `[` and `]` it left unhandled at its first or last question. */
function questionBodyOwnsKey(active: StoredApproval, action: DockKeyAction, event: KeyboardEvent): boolean {
  if (active.subject.kind !== "question") return false;
  return action.kind !== "page" || event.defaultPrevented || event.target instanceof HTMLInputElement;
}

/**
 * Always-mounted live region. A region inserted together with its text is often
 * not read, so it stays in the DOM and changes text when a request arrives.
 */
export function ApprovalAnnouncer({ requests }: { readonly requests: readonly StoredApproval[] }) {
  const newest = requests.at(-1);
  const waiting = requests.length > 1 ? `, ${requests.length} waiting` : "";
  return <p aria-live="assertive" className="sr-only">{newest ? `${approvalTitle(newest)}${waiting}` : ""}</p>;
}

function SubagentOrigin({ request }: { readonly request: StoredApproval }) {
  if (request.origin.kind !== "subagent" || !request.providerId) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 pl-1">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center"><ProviderIcon provider={request.providerId} size={16} /></span>
      <span className="text-xs text-muted text-fade">{request.origin.label}</span>
    </span>
  );
}

function RequestOrigin({ request, delegatedTitle }: { readonly request: StoredApproval; readonly delegatedTitle: string | undefined }) {
  if (delegatedTitle === undefined) return <SubagentOrigin request={request} />;
  return <span className="min-w-0 pl-1 text-xs text-muted text-fade">From {delegatedTitle}</span>;
}

/** Props for {@link ApprovalDock}. */
export interface ApprovalDockProps {
  /** Pending requests for the Coordinator and its Delegated threads, oldest first, never empty. */
  readonly requests: readonly StoredApproval[];
  /** Delegated thread titles by thread id; a request from one of them reads as from that thread. */
  readonly delegatedThreads: ReadonlyMap<string, string>;
  /** The hidden composer; focus inside it counts as the user's attention being here. */
  readonly composerContainerRef: RefObject<HTMLElement | null>;
  readonly isAgentRunning: boolean;
  readonly isStopPending: boolean;
  readonly onStop: () => void;
  readonly onFocusComposer: () => void;
}

/**
 * Pending approvals in place of the composer. Keys work only while focus is in the
 * dock, and the dock takes focus only from the composer or nowhere, so a user typing
 * in the terminal or browser panel cannot answer by accident.
 */
export function ApprovalDock({ requests, delegatedThreads, composerContainerRef, isAgentRunning, isStopPending, onStop, onFocusComposer }: ApprovalDockProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const guardUntilRef = useRef(0);
  const pagedToRef = useRef<string | undefined>(undefined);
  const { active, index, page } = useActiveRequest(requests);
  const [focusedRow, setFocusedRow] = useFocusedRow(active.requestId);
  const submission = useApprovalStore((state) => state.submissions[active.requestId]);
  const title = approvalTitle(active);
  const noteChoiceId = active.noteChoiceId;
  const rowCount = active.choices.length + (noteChoiceId ? 1 : 0);

  const arm = () => { guardUntilRef.current = Date.now() + APPROVAL_ARM_DELAY_MS; };

  const activeRequestId = active.requestId;
  useEffect(() => {
    // Paging is a deliberate choice; any other change (first show, a decision advancing) is a surprise to guard.
    if (pagedToRef.current !== activeRequestId) guardUntilRef.current = Date.now() + APPROVAL_ARM_DELAY_MS;
    pagedToRef.current = undefined;
  }, [activeRequestId]);
  // A question body has no choice rows, so its first option takes the focus.
  useDockFocus(rootRef, composerContainerRef, onFocusComposer,
    () => rowRefs.current[0] ?? rootRef.current?.querySelector<HTMLElement>("[role=group] button"), activeRequestId);

  const choose = (choice: ApprovalChoice) => {
    if (Date.now() < guardUntilRef.current || submission?.state === "submitting") return;
    void submitApprovalChoice(active, { choiceId: choice.id });
  };

  // Typing a note and pressing Enter is deliberate, so the misclick guard does not apply.
  const denyWithNote = (note: string) => {
    if (!noteChoiceId || submission?.state === "submitting") return;
    void submitApprovalChoice(active, { choiceId: noteChoiceId, note });
  };

  const moveFocus = (row: number) => {
    const target = Math.max(0, Math.min(rowCount - 1, row));
    setFocusedRow(target);
    rowRefs.current[target]?.focus();
  };

  const goTo = (delta: number) => {
    pagedToRef.current = page(delta);
  };

  const chooseRow = (row: number) => {
    const choice = active.choices[row];
    if (choice) choose(choice);
    else if (noteChoiceId && row === active.choices.length) moveFocus(row);
  };

  const runKey: Record<DockKeyAction["kind"], (value: number) => void> = {
    page: goTo,
    move: (delta) => moveFocus(focusedRow + delta),
    // A digit pressed too soon counts as typing, so the guard extends rather than the answer landing later.
    digit: (row) => (Date.now() < guardUntilRef.current ? arm() : chooseRow(row)),
    arm,
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = dockKeyAction(event);
    if (!action || questionBodyOwnsKey(active, action, event) || textFieldOwnsKey(action, event)) return;
    event.preventDefault();
    runKey[action.kind](action.value);
  };

  const retry = () => {
    if (submission) void submitApprovalChoice(active, submission.response);
  };

  const Icon = SUBJECT_ICONS[active.subject.kind];
  const delegatedTitle = delegatedThreads.get(active.threadId);
  const showCoordinatorStop = isAgentRunning && delegatedTitle === undefined;
  return (
    <div
      ref={rootRef}
      data-testid="approval-dock"
      className="relative z-(--layer-sticky) flex w-full flex-col gap-3 rounded-composer border border-primary/45 bg-panel px-4 py-3.5"
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={14} className="shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 text-sm font-medium text-ink">{title}</h2>
        <RequestOrigin request={active} delegatedTitle={delegatedTitle} />
        <span className="flex-1" />
        {requests.length > 1 && <ApprovalPager index={index} count={requests.length} onPrevious={() => goTo(-1)} onNext={() => goTo(1)} />}
      </div>
      {active.subject.kind === "question" ? (
        <ApprovalQuestionBody
          key={active.requestId}
          request={active}
          questions={active.subject.questions}
          isArmed={() => Date.now() >= guardUntilRef.current}
          arm={arm}
        />
      ) : (
        <>
          <ApprovalSubject subject={active.subject} />
          <div role="group" aria-label={title} className="flex flex-col gap-0.5">
            {active.choices.map((choice, row) => (
              <ApprovalChoiceRow
                key={choice.id}
                choice={choice}
                index={row}
                focused={row === focusedRow}
                submitting={submission?.state === "submitting" && submission.response.choiceId === choice.id}
                dimmed={submission?.state === "submitting" && submission.response.choiceId !== choice.id}
                submittingLabel={submittingLabel(choice)}
                buttonRef={(element) => { rowRefs.current[row] = element; }}
                onChoose={() => choose(choice)}
                onFocus={() => setFocusedRow(row)}
              />
            ))}
            {noteChoiceId && (
              <ApprovalNoteRow
                key={active.requestId}
                index={active.choices.length}
                label={noteRowLabel(active)}
                focused={focusedRow === active.choices.length}
                dimmed={submission?.state === "submitting"}
                inputRef={(element) => { rowRefs.current[active.choices.length] = element; }}
                onSubmit={denyWithNote}
                onFocus={() => setFocusedRow(active.choices.length)}
              />
            )}
          </div>
          {submission?.state === "failed" && (
            <div role="alert" className="flex items-center gap-2 text-sm">
              <CircleAlert size={14} className="shrink-0 text-error" aria-hidden />
              <span className="min-w-0 text-error">Your answer didn&apos;t reach {approvalActorName(active)}.</span>
              <span className="flex-1" />
              <button type="button" className="shrink-0 cursor-pointer font-medium text-ink" onClick={retry}>Try again</button>
            </div>
          )}
        </>
      )}
      {showCoordinatorStop && (
        <div className="-mt-1 -mb-1.5 flex justify-end">
          <DockStopButton isStopPending={isStopPending} onStop={onStop} />
        </div>
      )}
    </div>
  );
}
