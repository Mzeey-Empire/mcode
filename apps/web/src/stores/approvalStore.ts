import { create } from "zustand";
import type { ApprovalRequest, ApprovalResponse } from "@mcode/contracts/models/approval";

/**
 * Pending-approval state. A settled request stays as a tombstone so a late replay of
 * the same request cannot re-open it; the decision itself renders as a durable
 * narrative receipt.
 */
export type StoredApproval = ApprovalRequest & { settled: boolean };

/** An answer the user gives, as opposed to Mcode's automatic denial. */
export type ApprovalUserResponse = Exclude<ApprovalResponse, { autoDeny: unknown }>;

/** The answer the user picked for one request, kept in the store so it survives a dock remount. */
export interface ApprovalSubmission {
  readonly response: ApprovalUserResponse;
  readonly state: "submitting" | "failed";
}

interface ApprovalState {
  approvals: StoredApproval[];
  submissions: Readonly<Record<string, ApprovalSubmission>>;
  add(request: ApprovalRequest): void;
  resolve(requestId: string): void;
  remove(requestId: string): void;
  /** Drop the thread's turn-scoped requests when its turn ends; server-owned thread-control requests stay. */
  clearThread(threadId: string): void;
  hydrate(requests: ApprovalRequest[]): void;
  setSubmission(requestId: string, submission: ApprovalSubmission): void;
}

/** Submissions exist only for pending requests, so every change to the request list trims them. */
function pendingSubmissions(
  submissions: Readonly<Record<string, ApprovalSubmission>>,
  approvals: readonly StoredApproval[],
): Readonly<Record<string, ApprovalSubmission>> {
  const keep = (id: string) => approvals.some((item) => item.requestId === id && !item.settled);
  const ids = Object.keys(submissions);
  if (ids.every(keep)) return submissions;
  return Object.fromEntries(ids.filter(keep).map((id) => [id, submissions[id]!]));
}

function withApprovals(state: ApprovalState, approvals: StoredApproval[]): Partial<ApprovalState> {
  return { approvals, submissions: pendingSubmissions(state.submissions, approvals) };
}

/** Pending approvals for every thread, hydrated on socket connect and patched by live pushes. */
export const useApprovalStore = create<ApprovalState>((set) => ({
  approvals: [], submissions: {},
  add: (request) => set((state) => {
    const existing = state.approvals.find((item) => item.requestId === request.requestId);
    if (existing?.settled) return state;
    return { approvals: existing
      ? state.approvals.map((item) => item.requestId === request.requestId ? { ...request, settled: false } : item)
      : [...state.approvals, { ...request, settled: false }] };
  }),
  resolve: (requestId) => set((state) => withApprovals(state,
    state.approvals.map((item) => item.requestId === requestId ? { ...item, settled: true } : item))),
  remove: (requestId) => set((state) => withApprovals(state, state.approvals.filter((item) => item.requestId !== requestId))),
  clearThread: (threadId) => set((state) => withApprovals(state,
    state.approvals.filter((item) => item.threadId !== threadId || outlivesTurn(item)))),
  // The server builds this app-wide snapshot synchronously and answers on the
  // same ordered socket as approval pushes, so it already reflects every push
  // applied before it and needs no revision guard against them.
  hydrate: (requests) => set((state) => {
    const tombstones = state.approvals.filter((item) => item.settled);
    const tombstoned = new Set(tombstones.map((item) => item.requestId));
    return withApprovals(state, [...tombstones, ...requests
      .filter((request) => !tombstoned.has(request.requestId))
      .map((request) => ({ ...request, settled: false }))]);
  }),
  setSubmission: (requestId, submission) => set((state) => (
    // A response can land after the request was resolved or removed; recording it then would leak an entry.
    state.approvals.some((item) => item.requestId === requestId && !item.settled)
      ? { submissions: { ...state.submissions, [requestId]: submission } }
      : state
  )),
}));

// A thread-control request waits on the user, not on the turn that raised it, and the server resolves it itself.
function outlivesTurn(request: StoredApproval): boolean {
  return request.subject.kind === "thread_operation" || request.subject.kind === "delegate_task";
}

/** Whether the request is pending and belongs in the approval dock. */
export function isDockApproval(request: StoredApproval): boolean {
  return !request.settled;
}

const NO_THREADS: ReadonlySet<string> = new Set();

/**
 * Pending dock requests for the thread and its Delegated threads, oldest first.
 * A Delegated thread's question is answered from the Coordinator the user is watching.
 */
export function selectDockApprovals(
  approvals: readonly StoredApproval[],
  threadId: string | undefined,
  delegatedThreadIds: ReadonlySet<string> = NO_THREADS,
): StoredApproval[] {
  if (!threadId) return [];
  return approvals
    .filter((request) => (request.threadId === threadId || delegatedThreadIds.has(request.threadId)) && isDockApproval(request))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}
