import { create } from "zustand";
import type { ApprovalRequest } from "@mcode/contracts";

/**
 * Inline-card state. A settled request stays as a tombstone so a late replay of
 * the same request cannot re-open its card; the decision itself renders as a
 * durable narrative receipt.
 */
export type StoredApproval = ApprovalRequest & { settled: boolean };

interface ApprovalState {
  approvals: StoredApproval[];
  add(request: ApprovalRequest): void;
  resolve(requestId: string): void;
  remove(requestId: string): void;
  clearThread(threadId: string): void;
  hydrate(requests: ApprovalRequest[]): void;
}

/** Pending approvals for every thread, hydrated on socket connect and patched by live pushes. */
export const useApprovalStore = create<ApprovalState>((set) => ({
  approvals: [],
  add: (request) => set((state) => {
    const existing = state.approvals.find((item) => item.requestId === request.requestId);
    if (existing?.settled) return state;
    return { approvals: existing
      ? state.approvals.map((item) => item.requestId === request.requestId ? { ...request, settled: false } : item)
      : [...state.approvals, { ...request, settled: false }] };
  }),
  resolve: (requestId) => set((state) => ({
    approvals: state.approvals.map((item) => item.requestId === requestId ? { ...item, settled: true } : item) })),
  remove: (requestId) => set((state) => ({ approvals: state.approvals.filter((item) => item.requestId !== requestId) })),
  clearThread: (threadId) => set((state) => ({ approvals: state.approvals.filter((item) => item.threadId !== threadId) })),
  // The server builds this app-wide snapshot synchronously and answers on the
  // same ordered socket as approval pushes, so it already reflects every push
  // applied before it and needs no revision guard against them.
  hydrate: (requests) => set((state) => {
    const tombstones = state.approvals.filter((item) => item.settled);
    const tombstoned = new Set(tombstones.map((item) => item.requestId));
    return { approvals: [...tombstones, ...requests
      .filter((request) => !tombstoned.has(request.requestId))
      .map((request) => ({ ...request, settled: false }))] };
  }),
}));
