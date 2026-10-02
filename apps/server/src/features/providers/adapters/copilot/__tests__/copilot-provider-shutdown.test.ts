import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { CopilotSession } from "@github/copilot-sdk";
import { AgentEventType, getDefaultSettings, ProviderRuntimeEventSchema, type ProviderRuntimeEvent } from "@mcode/contracts";
import type { ProviderEventBatch } from "@mcode/providers";
import { CopilotProvider } from "../copilot-provider.js";
import { mockShutdownHost } from "../../../composition/__tests__/helpers/mock-shutdown-host.js";
import { stubEnvService } from "../../../../../runtime/environment/__tests__/stub-env-service.js";
import { stubJobObject } from "../../../../../runtime/process/containment/__tests__/stub-job-object.js";
import { SettingsService } from "../../../../settings/settings-service.js";

vi.mock("../../../../settings/settings-service.js", () => ({
  SettingsService: class { get() { return getDefaultSettings(); } },
}));

type SdkConnection = ConstructorParameters<typeof CopilotSession>[1];

function mockSdkConnection() {
  const sendRequest = vi.fn().mockResolvedValue({ messageId: "message-shutdown" });
  const subscribe = () => ({ dispose: () => {} });
  const connection: SdkConnection = {
    sendRequest, onRequest: subscribe, hasPendingResponse: () => false,
    sendNotification: async () => {}, onNotification: subscribe, onUnhandledNotification: subscribe,
    onProgress: subscribe, sendProgress: async () => {}, onUnhandledProgress: subscribe,
    trace: async () => {}, onError: subscribe, onClose: subscribe,
    listen: () => {}, end: () => {}, onDispose: subscribe, dispose: () => {}, inspect: () => {},
  };
  return { connection, sendRequest };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("CopilotProvider shutdown", () => {
  it("settles a disconnected SDK turn and waits for its final canonical event", async () => {
    let endedEntered = false;
    const endedReleased = deferred();
    const { connection, sendRequest } = mockSdkConnection();
    const session = new CopilotSession("sdk-shutdown", connection);
    const events: ProviderRuntimeEvent[] = [];
    const baseHost = mockShutdownHost((event) => events.push(event));
    const host = {
      ...baseHost,
      events: {
        submit: async (batch: ProviderEventBatch) => {
          if (batch.events.some((draft) => draft.payload.type === "item.recorded"
            && draft.payload.item.payload.projection === "providerRuntimeEvent"
            && ProviderRuntimeEventSchema().parse(draft.payload.item.payload.runtimeEvent).event.type === AgentEventType.Ended)) {
            endedEntered = true;
            await endedReleased.promise;
          }
          return baseHost.events.submit(batch);
        },
      },
    };
    const provider = new CopilotProvider(new SettingsService(), stubJobObject(), stubEnvService(), undefined, undefined, host);
    Reflect.set(provider, "client", { getState: () => "connected", stop: async () => [] });
    vi.spyOn(provider, "spawn").mockResolvedValue({
      state: {
        sessionId: "mcode-thread-shutdown", session, lastUsedAt: Date.now(), turnActive: false,
        workspaceId: "workspace-shutdown", browserPermissionCapability: "interact",
      },
      pids: [],
    });
    let stopping: Promise<void> | undefined;
    try {
      await provider.sendTurn({
        turnId: "turn-shutdown", turnExecutionId: "11111111-1111-4111-8111-111111111111",
        sessionId: "mcode-thread-shutdown", threadId: "thread-shutdown", workspaceId: "workspace-shutdown", message: "hi", cwd: "/tmp",
        model: "gpt-5", permissionMode: "supervised", approvalReviewMode: "manual", interactionMode: "build", providerOptions: {},
      });
      let completed = false;
      stopping = provider.shutdown().then(() => { completed = true; });
      await vi.waitFor(() => expect(endedEntered).toBe(true));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      expect(sendRequest.mock.calls.map(([method]) => method)).toContain("session.destroy");

      endedReleased.resolve();
      await stopping;
      expect(events.map(({ event }) => event.type)).toContain(AgentEventType.Ended);
    } finally {
      endedReleased.resolve();
      await (stopping ?? provider.shutdown());
    }
  });
});
