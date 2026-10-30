import { useLayoutEffect } from "react";
import { create } from "zustand";
import type { VirtualViewport } from "@/components/ui/virtual-viewport";

/** One explicit Send that should bring a thread's transcript to its newest prompt. */
export interface TranscriptFollowRequest {
  readonly threadId: string;
}

interface TranscriptFollowState {
  readonly request: TranscriptFollowRequest | null;
  readonly consume: (request: TranscriptFollowRequest) => void;
}

/** Holds the latest explicit Send until that thread's transcript consumes it. */
export const useTranscriptFollowStore = create<TranscriptFollowState>((set) => ({
  request: null,
  consume: (request) => set((state) => (state.request === request ? { request: null } : state)),
}));

/**
 * Asks the thread's transcript to follow the tail. Only an explicit Send calls this: an automatic
 * queued send must not pull a reader who scrolled up away from what they are reading.
 */
export function requestTranscriptFollow(threadId: string): void {
  useTranscriptFollowStore.setState({ request: { threadId } });
}

/** Moves the transcript of `threadId` to its end when an explicit Send targets that thread. */
export function useFollowOnSend(threadId: string | null | undefined, getView: () => VirtualViewport | null): void {
  const request = useTranscriptFollowStore((state) =>
    state.request?.threadId === threadId ? state.request : null);
  useLayoutEffect(() => {
    const view = getView();
    if (!request || !view) return;
    useTranscriptFollowStore.getState().consume(request);
    view.moveTo({ kind: "end" });
  }, [request, getView]);
}
