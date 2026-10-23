import { describe, expect, it } from "vitest";
import {
  BROWSER_AUTOMATION_CONTRACT_VERSION,
  BROWSER_AUTOMATION_OPERATIONS,
  type BrowserAutomationHostDispatchTarget,
  type BrowserAutomationHostRegistration,
  type BrowserAutomationRequest,
} from "@mcode/contracts";
import type { WebSocket } from "ws";
import { BrowserAutomationBroker } from "../broker.js";
import type { BrowserAutomationCredentialClaims } from "../../access/credential-registry.js";

const HOST_ID = "user-tab-host";
const USER_TAB = "user-tab";
const AGENT_TAB = "agent-tab";

type Controller = NonNullable<BrowserAutomationHostDispatchTarget["controller"]>;

interface Delivery {
  readonly dispatch: { readonly request: BrowserAutomationRequest; readonly target: BrowserAutomationHostDispatchTarget };
}

function registration(): BrowserAutomationHostRegistration {
  return {
    contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
    hostId: HOST_ID,
    runtime: "electron",
    desktopInstanceId: `desktop-${HOST_ID}`,
    worktreeIdentity: "worktree-a",
    workspaceIds: ["workspace-a"],
    executorDescriptor: {
      runtime: "electron",
      operations: [...BROWSER_AUTOMATION_OPERATIONS],
      constraints: { maxTabs: 32, maxSnapshotChars: 20_000, maxDiagnostics: 200 },
      capabilityRevision: 1,
    },
    capabilities: BROWSER_AUTOMATION_OPERATIONS.map((operation) => ({ operation, available: true })),
    maxPendingRequests: 4,
    connectedAt: 1,
  };
}

const scope: BrowserAutomationCredentialClaims = {
  credentialId: "credential-thread-a",
  providerId: "cursor",
  providerSessionId: "provider-thread-a",
  mcodeSessionId: "mcode-thread-a",
  threadId: "thread-a",
  workspaceId: "workspace-a",
  worktreeIdentity: "worktree-a",
  permissionCapability: "interact",
  allowedOperations: ["open", "inspect", "act", "tabs"],
  issuedAt: 1,
  expiresAt: 100_000,
};

function target(
  generation: number,
  tabId: string,
  overrides: Partial<BrowserAutomationHostDispatchTarget> = {},
): BrowserAutomationHostDispatchTarget {
  return {
    desktopInstanceId: `desktop-${HOST_ID}`,
    windowId: 1,
    connectionGeneration: generation,
    threadId: "thread-a",
    tabId,
    targetGeneration: 1,
    active: false,
    focused: false,
    lastUsedAt: 1,
    ...overrides,
  };
}

function userHold(epoch: number): Controller {
  return { tabId: USER_TAB, controller: "human", controlEpoch: epoch };
}

/** A Browser with a user-opened tab and an agent tab in one thread, reachable through one host. */
function browser(options: { readonly userController?: Controller; readonly focusedTab?: string; readonly agentTab?: boolean } = {}) {
  const deliveries: Delivery[] = [];
  const broker = new BrowserAutomationBroker({
    now: () => 10,
    send: (_socket, channel, data) => {
      if (channel === "browserAutomation.request") deliveries.push(data as Delivery);
      return true;
    },
  });
  const hostSocket = { name: HOST_ID } as unknown as WebSocket;
  const generation = broker.registerHost(hostSocket, registration(), {
    desktopInstanceId: `desktop-${HOST_ID}`,
    worktreeIdentity: "worktree-a",
    allowedWorkspaceIds: ["workspace-a"],
  }).generation;
  const focusedTab = options.focusedTab ?? USER_TAB;
  const publish = (userController: Controller | undefined): void => {
    broker.updateTargets(hostSocket, HOST_ID, generation, [
      target(generation, USER_TAB, {
        active: true,
        focused: focusedTab === USER_TAB,
        ...(userController ? { controller: userController } : {}),
      }),
      ...(options.agentTab === false ? [] : [target(generation, AGENT_TAB, { focused: focusedTab === AGENT_TAB, lastUsedAt: 2 })]),
    ]);
  };
  publish(options.userController);
  let sequence = 0;
  const send = (operation: BrowserAutomationRequest["operation"], args: Record<string, unknown>, expectedControlEpoch = 0) => {
    sequence += 1;
    const request = {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: scope.mcodeSessionId,
      requestId: `request-${sequence}`,
      sequence,
      deadline: 50_000,
      expectedControlEpoch,
      operation,
      args,
    } as BrowserAutomationRequest;
    return broker.execute(scope, request);
  };
  /** Answers the latest delivery the way a host answers an inspect of its target. */
  const answerInspect = (controlEpoch = 0): Delivery => {
    const delivery = deliveries.at(-1)!;
    const inspected = delivery.dispatch.target;
    broker.respond(hostSocket, HOST_ID, generation, {
      contractVersion: BROWSER_AUTOMATION_CONTRACT_VERSION,
      requestId: delivery.dispatch.request.requestId,
      sequence: delivery.dispatch.request.sequence,
      ok: true,
      result: {
        operation: "inspect",
        controlEpoch,
        // Hosts list the thread's tabs without their holder.
        tabs: [target(generation, USER_TAB, { active: true }), target(generation, AGENT_TAB, { lastUsedAt: 2 })],
        observationRef: `observation-${delivery.dispatch.request.sequence}`,
        snapshot: snapshotOf(inspected.tabId),
      },
    });
    return delivery;
  };
  return { broker, deliveries, publish, send, answerInspect };
}

function snapshotOf(tabId: string) {
  const none = { truncated: false as const };
  return {
    url: `https://example.test/${tabId}`,
    title: `Page in ${tabId}`,
    loading: false,
    visibleText: `Content of ${tabId}`,
    visibleTextTruncation: none,
    elements: [],
    elementsTruncation: none,
    accessibility: [],
    accessibilityTruncation: none,
    console: [],
    consoleTruncation: none,
    network: [],
    networkTruncation: none,
    actions: [],
    actionsTruncation: none,
  };
}

const INSPECT = { includeScreenshot: false, includeDiagnostics: false };

describe("BrowserAutomationBroker reading the user's own tab", () => {
  it("reads the user's tab when the agent has no tab of its own", async () => {
    const { send, answerInspect } = browser({ agentTab: false });

    const pending = send("inspect", INSPECT);
    const delivery = answerInspect();

    expect(delivery.dispatch.target.tabId).toBe(USER_TAB);
    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { snapshot: { url: `https://example.test/${USER_TAB}`, title: `Page in ${USER_TAB}`, visibleText: `Content of ${USER_TAB}` } },
    });
  });

  it("reads a named tab the user holds without moving the agent off its own tab", async () => {
    const { send, answerInspect } = browser({ focusedTab: AGENT_TAB, userController: userHold(2) });
    const sticky = send("inspect", INSPECT);
    expect(answerInspect(2).dispatch.target.tabId).toBe(AGENT_TAB);
    await sticky;

    const named = send("inspect", { ...INSPECT, tabId: USER_TAB });
    expect(answerInspect(2).dispatch.target.tabId).toBe(USER_TAB);
    await expect(named).resolves.toMatchObject({
      ok: true,
      result: { target: { tabId: USER_TAB }, snapshot: { visibleText: `Content of ${USER_TAB}` } },
    });

    const next = send("inspect", INSPECT);
    expect(answerInspect(2).dispatch.target.tabId).toBe(AGENT_TAB);
    await next;
  });

  it("keeps the user's hold after the agent reads the held tab", async () => {
    const { send, answerInspect } = browser({ userController: userHold(2) });

    const first = send("inspect", { ...INSPECT, tabId: USER_TAB });
    answerInspect(2);
    await first;
    const second = send("inspect", { ...INSPECT, tabId: USER_TAB });
    answerInspect(2);

    await expect(second).resolves.toMatchObject({
      ok: true,
      result: { readiness: { ready: false, state: "human-control" }, tabs: expect.arrayContaining([expect.objectContaining({ tabId: USER_TAB, controller: userHold(2) })]) },
    });
  });

  it("refuses a named tab that is not in the thread", async () => {
    const { send, deliveries } = browser();

    await expect(send("inspect", { ...INSPECT, tabId: "elsewhere" })).resolves.toMatchObject({
      ok: false,
      error: { code: "TAB_UNAVAILABLE", recovery: "inspect" },
    });
    expect(deliveries).toHaveLength(0);
  });

  it("lists every thread tab with the holder the broker enforces", async () => {
    const { send, answerInspect } = browser({ userController: userHold(4) });

    const pending = send("inspect", { ...INSPECT, tabId: AGENT_TAB });
    answerInspect(4);

    const response = await pending;
    expect(response.ok && response.result.operation === "inspect" && response.result.tabs.map((tab) => [tab.tabId, tab.controller?.controller]))
      .toEqual([[AGENT_TAB, undefined], [USER_TAB, "human"]]);
  });

  it("reports the Browser as not ready while the user holds another tab in the thread", async () => {
    const { send, answerInspect } = browser({ userController: userHold(1) });

    const pending = send("inspect", { ...INSPECT, tabId: AGENT_TAB });
    answerInspect(1);

    await expect(pending).resolves.toMatchObject({
      ok: true,
      result: { readiness: { ready: false, state: "human-control" } },
    });
  });

  it("refuses an action on the user's held tab and admits it after Hand back", async () => {
    const { send, publish, deliveries } = browser({ agentTab: false, userController: userHold(1) });
    const act = { idempotencyKey: "act-key", observationRef: "observation", deadlineMs: 1_000, steps: [{ operation: "press", key: "A", modifiers: [] }] };

    await expect(send("act", act, 1)).resolves.toMatchObject({
      ok: false,
      error: { code: "HUMAN_INTERRUPTED", recovery: "yield_to_user" },
    });
    expect(deliveries).toHaveLength(0);

    publish({ tabId: USER_TAB, controller: "none", controlEpoch: 2 });
    void send("act", { ...act, idempotencyKey: "act-after-hand-back" }, 2);

    expect(deliveries.map(({ dispatch }) => [dispatch.request.operation, dispatch.target.tabId])).toEqual([["act", USER_TAB]]);
  });
});
