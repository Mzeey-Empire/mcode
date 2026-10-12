import { create } from "zustand";
import type { ApprovalRequest } from "@mcode/contracts";

/**
 * Pending-approval state. A settled request stays as a tombstone so a late replay of
 * the same request cannot re-open it; the decision itself renders as a durable
 * narrative receipt.
 */
export type StoredApproval = ApprovalRequest & { settled: boolean };

/** The answer the user picked for one request, kept in the store so it survives a dock remount. */
export interface ApprovalSubmission {
  readonly choiceId: string;
  readonly state: "submitting" | "failed";
}

interface ApprovalState {
  approvals: StoredApproval[];
  submissions: Readonly<Record<string, ApprovalSubmission>>;
  add(request: ApprovalRequest): void;
  resolve(requestId: string): void;
  remove(requestId: string): void;
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
  clearThread: (threadId) => set((state) => withApprovals(state, state.approvals.filter((item) => item.threadId !== threadId))),
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

/** Whether the request belongs in the approval dock; questions stay in the transcript until the question dock lands. */
export function isDockApproval(request: StoredApproval): boolean {
  return !request.settled && request.subject.kind !== "question";
}

/** Dock requests for one thread, oldest first, so the pager reads in the order the agent asked. */
export function selectDockApprovals(approvals: readonly StoredApproval[], threadId: string | undefined): StoredApproval[] {
  if (!threadId) return [];
  return approvals
    .filter((request) => request.threadId === threadId && isDockApproval(request))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}
