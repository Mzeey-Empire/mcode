import { useDiffStore } from "@/stores/diffStore";
import { createMockMessage, createMockThread } from "@mcode/contracts/testing";
import { createEmptyThreadRecord } from "@/stores/thread-record";
import { useThreadStore } from "@/stores/threadStore";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { selectSidebarFacts, selectThreadIndex } from "@/features/projects/state/thread-index";
import { resetWorkerForPerformance } from "@/lib/shiki-worker-client";
import { resetChatHighlightCoordinator } from "@/lib/chat-highlight-coordinator";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import {
  clearScrollMemory,
  forgetScrollTop,
  recallScrollPosition,
} from "@/components/chat/scrollPositionMemory";
import {
  drainShikiPerformanceObservations,
  resetShikiPerformanceObservations,
  setShikiPerformanceCapture,
} from "./shiki-performance";
import {
  drainMessageListPerformanceObservations,
  resetMessageListPerformanceObservations,
} from "./message-list-performance";
import { runVListReactAdapterLifecycleProbe } from "./vlist-react-adapter-prototype";
import { pushEmitter } from "@/transport/ws-transport";
import { createAgentModelState, reduceAgentEventBatch } from "@mcode/contracts/compat/agent-model";

function resetShikiPerformanceWorker(): void {
  resetWorkerForPerformance();
  resetChatHighlightCoordinator();
}

declare global {
  interface Window {
    __mcodeFrontendPerformanceModules?: {
      readonly workspaceStore: typeof useWorkspaceStore;
      readonly threadStore: typeof useThreadStore;
      readonly diffStore: typeof useDiffStore;
      readonly createEmptyThreadRecord: typeof createEmptyThreadRecord;
      readonly createMockMessage: typeof createMockMessage;
      readonly createMockThread: typeof createMockThread;
      readonly shikiPerformance: {
        readonly drain: typeof drainShikiPerformanceObservations;
        readonly reset: typeof resetShikiPerformanceObservations;
        readonly setCapture: typeof setShikiPerformanceCapture;
        readonly resetWorker: typeof resetShikiPerformanceWorker;
      };
      readonly messageListPerformance: {
        readonly drain: typeof drainMessageListPerformanceObservations;
        readonly reset: typeof resetMessageListPerformanceObservations;
      };
      /** The sidebar's memoized selectors, so a heap probe can hold the caches they return. */
      readonly sidebarCaches: {
        readonly facts: typeof selectSidebarFacts;
        readonly index: typeof selectThreadIndex;
      };
      readonly vlistLifecycle: {
        readonly run: typeof runVListReactAdapterLifecycleProbe;
      };
      readonly recordCache: {
        readonly clear: typeof clearRecordCache;
      };
      readonly scrollMemory: {
        readonly clear: typeof clearScrollMemory;
        readonly forget: typeof forgetScrollTop;
        readonly recall: typeof recallScrollPosition;
      };
      /** Delivers a recorded server push through the same listeners a live socket frame reaches. */
      readonly push: (channel: string, data: unknown) => void;
      /** Builds the durable snapshot a recorded turn's recovery frame carries. */
      readonly agentModel: {
        readonly create: typeof createAgentModelState;
        readonly reduce: typeof reduceAgentEventBatch;
      };
    };
  }
}

/** Exposes the compiled store seam used by the maintained performance fixture. */
export function installFrontendRendererFixtureBridge(): void {
  window.__mcodeFrontendPerformanceModules = {
    workspaceStore: useWorkspaceStore,
    threadStore: useThreadStore,
    diffStore: useDiffStore,
    createEmptyThreadRecord,
    createMockMessage,
    createMockThread,
    shikiPerformance: {
      drain: drainShikiPerformanceObservations,
      reset: resetShikiPerformanceObservations,
      setCapture: setShikiPerformanceCapture,
      resetWorker: resetShikiPerformanceWorker,
    },
    messageListPerformance: {
      drain: drainMessageListPerformanceObservations,
      reset: resetMessageListPerformanceObservations,
    },
    sidebarCaches: { facts: selectSidebarFacts, index: selectThreadIndex },
    vlistLifecycle: {
      run: runVListReactAdapterLifecycleProbe,
    },
    recordCache: {
      clear: clearRecordCache,
    },
    scrollMemory: {
      clear: clearScrollMemory,
      forget: forgetScrollTop,
      recall: recallScrollPosition,
    },
    push: (channel, data) => pushEmitter.emit(channel, data),
    agentModel: { create: createAgentModelState, reduce: reduceAgentEventBatch },
  };
}
