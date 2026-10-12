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
  revision: number;
  add(request: ApprovalRequest): void;
  resolve(requestId: string): void;
  remove(requestId: string): void;
  clearThread(threadId: string): void;
  replaceThread(threadId: string, requests: ApprovalRequest[], expectedRevision: number): void;
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
  return { revision: state.revision + 1, approvals, submissions: pendingSubmissions(state.submissions, approvals) };
}

/** Live approvals shared by the approval dock, transcript question cards, and sidebar attention selectors. */
export const useApprovalStore = create<ApprovalState>((set) => ({
  approvals: [], submissions: {}, revision: 0,
  add: (request) => set((state) => {
    const existing = state.approvals.find((item) => item.requestId === request.requestId);
    if (existing?.settled) return state;
    return { revision: state.revision + 1, approvals: existing
      ? state.approvals.map((item) => item.requestId === request.requestId ? { ...request, settled: false } : item)
      : [...state.approvals, { ...request, settled: false }] };
  }),
  resolve: (requestId) => set((state) => withApprovals(state,
    state.approvals.map((item) => item.requestId === requestId ? { ...item, settled: true } : item))),
  remove: (requestId) => set((state) => withApprovals(state, state.approvals.filter((item) => item.requestId !== requestId))),
  clearThread: (threadId) => set((state) => withApprovals(state, state.approvals.filter((item) => item.threadId !== threadId))),
  replaceThread: (threadId, requests, expectedRevision) => set((state) => {
    const current = state.approvals.filter((item) => item.threadId === threadId && !item.settled).map(({ settled: _settled, ...request }) => request);
    if (state.revision !== expectedRevision || JSON.stringify(current) === JSON.stringify(requests)) return state;
    return withApprovals(state, [...state.approvals.filter((item) => item.threadId !== threadId || item.settled),
      ...requests.filter((request) => !state.approvals.some((item) => item.requestId === request.requestId && item.settled)).map((request) => ({ ...request, settled: false }))]);
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
