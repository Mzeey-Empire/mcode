import { create } from "zustand";
import type { ApprovalOutcome, ApprovalRequest } from "@mcode/contracts";

/** Temporary inline-card state; durable receipts are owned by S06-03. */
export type StoredApproval = ApprovalRequest & { settled: boolean; outcome?: ApprovalOutcome };

interface ApprovalState {
  approvals: StoredApproval[];
  revision: number;
  add(request: ApprovalRequest): void;
  resolve(requestId: string, outcome: ApprovalOutcome): void;
  remove(requestId: string): void;
  clearThread(threadId: string): void;
  replaceThread(threadId: string, requests: ApprovalRequest[], expectedRevision: number): void;
}

/** Live approvals shared by transcript cards and sidebar attention selectors. */
export const useApprovalStore = create<ApprovalState>((set) => ({
  approvals: [], revision: 0,
  add: (request) => set((state) => {
    const existing = state.approvals.find((item) => item.requestId === request.requestId);
    if (existing?.settled) return state;
    return { revision: state.revision + 1, approvals: existing
      ? state.approvals.map((item) => item.requestId === request.requestId ? { ...request, settled: false } : item)
      : [...state.approvals, { ...request, settled: false }] };
  }),
  resolve: (requestId, outcome) => set((state) => ({ revision: state.revision + 1,
    approvals: state.approvals.map((item) => item.requestId === requestId ? { ...item, settled: true, outcome } : item) })),
  remove: (requestId) => set((state) => ({ revision: state.revision + 1, approvals: state.approvals.filter((item) => item.requestId !== requestId) })),
  clearThread: (threadId) => set((state) => ({ revision: state.revision + 1, approvals: state.approvals.filter((item) => item.threadId !== threadId) })),
  replaceThread: (threadId, requests, expectedRevision) => set((state) => {
    const current = state.approvals.filter((item) => item.threadId === threadId && !item.settled).map(({ settled: _settled, outcome: _outcome, ...request }) => request);
    if (state.revision !== expectedRevision || JSON.stringify(current) === JSON.stringify(requests)) return state;
    return {
    revision: state.revision + 1,
    approvals: [...state.approvals.filter((item) => item.threadId !== threadId || item.settled),
      ...requests.filter((request) => !state.approvals.some((item) => item.requestId === request.requestId && item.settled)).map((request) => ({ ...request, settled: false }))],
    };
  }),
}));
