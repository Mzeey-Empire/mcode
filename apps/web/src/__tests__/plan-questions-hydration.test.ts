import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanQuestion, PlanSnapshot } from "@mcode/contracts";
import {
  activateTestConversation,
  getTestThreadPlanQuestions,
  getTestThreadPlanQuestionsStatus,
  resetThreadStoreForTests,
} from "@/stores/thread-store-test-utils";
import { createEmptyThreadRecord, type ThreadRecord } from "@/stores/thread-record";
import { clearRecordCache } from "@/features/conversation/hydration/record-cache";
import { useThreadStore } from "@/stores/threadStore";
import { mockTransport } from "./mocks/transport";

vi.mock("@/transport", async () => ({
  ...(await vi.importActual("@/transport")),
  getTransport: () => mockTransport,
}));

const liveBatch: PlanQuestion[] = [
  {
    id: "q1",
    category: "AUTH",
    question: "Which provider?",
    options: [
      { id: "o1", title: "OAuth", description: "Use OAuth" },
      { id: "o2", title: "Password", description: "Use a password" },
    ],
  },
];

describe("thread hydration with a live plan-questions batch", () => {
  const threadId = "thread-1";

  beforeEach(() => {
    clearRecordCache();
    resetThreadStoreForTests({
      currentThreadId: threadId,
      records: new Map<string, ThreadRecord>([[threadId, createEmptyThreadRecord()]]),
    });
    vi.clearAllMocks();
  });

  it("keeps a batch that arrived while an older plan snapshot was in flight", async () => {
    let resolveSnapshot!: (snapshot: PlanSnapshot) => void;
    const olderSnapshot = new Promise<PlanSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.mocked(mockTransport.getPlanSnapshot).mockReturnValueOnce(olderSnapshot);

    await activateTestConversation(threadId);
    await vi.waitFor(() => expect(mockTransport.getPlanSnapshot).toHaveBeenCalledWith(threadId));

    useThreadStore.getState().setPlanQuestions(threadId, liveBatch);
    resolveSnapshot({ versions: [], phase: null, pendingQuestions: null });
    await olderSnapshot;
    await Promise.resolve();

    expect(getTestThreadPlanQuestionsStatus(threadId)).toBe("pending");
    expect(getTestThreadPlanQuestions(threadId)).toEqual(liveBatch);
  });
});
