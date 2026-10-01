import { afterEach, expect, it, vi } from "vitest";
import { CanonicalAgentProgressFrameSchema, MessageSchema, createAgentModelState, reduceAgentEventBatch, type CanonicalAgentProgressFrame } from "@mcode/contracts";
import { useThreadStore } from "@/stores/threadStore";
import { resetThreadStoreForTests, seedThreadRecord } from "@/stores/thread-store-test-utils";
import { mockTransport } from "./mocks/transport";
import capture from "./fixtures/canonical-saved-admission.json";

vi.mock("@/transport", async () => ({ ...(await vi.importActual("@/transport")), getTransport: () => mockTransport }));
afterEach(() => { vi.restoreAllMocks(); resetThreadStoreForTests(); });

function savedAdmissionFrame(frames: readonly CanonicalAgentProgressFrame[], payloadType: "turn.created" | "publication.recorded") {
  const frame = frames.find((candidate) => candidate.phase === "saved" && candidate.events.some((event) =>
    event.payload.type === payloadType && event.routing.executionId === capture.executionId));
  if (!frame || frame.phase !== "saved") throw new Error("missing captured admission");
  return frame;
}

function capturedPrompt(frame: Extract<CanonicalAgentProgressFrame, { phase: "saved" }>) {
  const prompt = frame.events.flatMap((event) => event.payload.type === "item.recorded" && event.payload.item.payload.projection === "message"
    ? [MessageSchema().parse(event.payload.item.payload.message)] : []).find((message) => message.role === "user");
  if (!prompt) throw new Error("missing captured prompt");
  return prompt;
}

function replayLiveFrames(frames: readonly CanonicalAgentProgressFrame[], epoch: string): void {
  for (const frame of frames) {
    if (frame.epoch === epoch && frame.phase !== "recovery" && frame.through > 0) useThreadStore.getState().handleCanonicalProgress(frame);
  }
}

it("settles the captured saved-only admission and accepted interrupted terminal", async () => {
  const { threadId, executionId } = capture;
  const frames = capture.frames.map((frame) => CanonicalAgentProgressFrameSchema().parse(frame));
  const admission = savedAdmissionFrame(frames, "turn.created");
  const start = savedAdmissionFrame(frames, "publication.recorded");
  const prompt = capturedPrompt(admission);
  const randomUUID = crypto.randomUUID.bind(crypto);
  const [first, second, third, fourth, fifth] = prompt.id.split("-");
  vi.spyOn(crypto, "randomUUID").mockImplementationOnce(randomUUID).mockReturnValueOnce(`${first}-${second}-${third}-${fourth}-${fifth}`).mockImplementation(randomUUID);
  vi.mocked(mockTransport.sendMessage).mockResolvedValueOnce(undefined);
  resetThreadStoreForTests();
  useThreadStore.setState({ records: seedThreadRecord(threadId), currentThreadId: threadId });
  await useThreadStore.getState().sendMessage(threadId, prompt.content);
  expect(useThreadStore.getState().records.get(threadId)?.turnExecutionId).toBeNull();
  const reduced = reduceAgentEventBatch(createAgentModelState(), [...admission.events, ...start.events]);
  if (reduced.outcome === "rejected") throw new Error("captured admission reduction failed");
  // The capture omitted the subscription response, so reconstruct its saved admission base.
  useThreadStore.getState().handleCanonicalProgress({ phase: "recovery", threadId, epoch: start.epoch,
    acceptedThrough: 0, savedThrough: 0, retained: [], loss: "none",
    durable: { mode: "snapshot", threadId, snapshot: { revision: start.revision, state: reduced.state } } });
  replayLiveFrames(frames, start.epoch);
  const record = useThreadStore.getState().records.get(threadId);
  expect(Object.values(record?.canonicalAgent.state.turns ?? {}).find((turn) => turn.executionId === executionId)?.status).toBe("Interrupted");
  expect(record?.runtimePhase).toBe("interrupted");
  expect(record?.turnExecutionId).toBe(executionId);
  expect(useThreadStore.getState().runningThreadIds.has(threadId)).toBe(false);
});
