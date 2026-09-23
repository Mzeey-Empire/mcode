import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWsTransport } from "../transport/ws-transport";

class MockWebSocket {
  static readonly OPEN = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;

  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }

  send(_data: string) {}

  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

let mockWsInstance: MockWebSocket;

beforeEach(() => {
  vi.stubGlobal(
    "WebSocket",
    new Proxy(MockWebSocket, {
      construct(Target) {
        const instance = new Target();
        mockWsInstance = instance;
        return instance;
      },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitForConnection", () => {
  it("resolves when WebSocket opens within timeout", async () => {
    const transport = createWsTransport("ws://localhost:1234");
    const connectPromise = transport.waitForConnection(5000);
    mockWsInstance.simulateOpen();
    await expect(connectPromise).resolves.toBeUndefined();
    transport.close();
  });

  it("rejects when WebSocket does not open within timeout", async () => {
    vi.useFakeTimers();
    const transport = createWsTransport("ws://localhost:1234");
    const connectPromise = transport.waitForConnection(3000);
    vi.advanceTimersByTime(3000);
    await expect(connectPromise).rejects.toThrow(
      "Could not connect to server at ws://localhost:1234",
    );
    transport.close();
    vi.useRealTimers();
  });
});

describe("onStatusChange", () => {
  it("fires 'connected' when WebSocket opens", () => {
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    expect(statusSpy).toHaveBeenCalledWith("connected");
    transport.close();
  });

  it("fires 'reconnecting' when WebSocket closes and reconnect is scheduled", () => {
    vi.useFakeTimers();
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    mockWsInstance.simulateClose();
    expect(statusSpy).toHaveBeenCalledWith("reconnecting");
    transport.close();
    vi.useRealTimers();
  });

  it("does not fire 'reconnecting' when transport is intentionally closed", () => {
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    transport.close();
    expect(statusSpy).not.toHaveBeenCalledWith("reconnecting");
  });
});

describe("4001 auth failure handling", () => {
  it("fires 'authFailed' status when closed with code 4001", () => {
    vi.useFakeTimers();
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    mockWsInstance.simulateClose(4001);
    expect(statusSpy).toHaveBeenCalledWith("authFailed");
    expect(statusSpy).not.toHaveBeenCalledWith("reconnecting");
    transport.close();
    vi.useRealTimers();
  });

  it("fires 'reconnecting' for non-4001 close codes", () => {
    vi.useFakeTimers();
    const statusSpy = vi.fn();
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: statusSpy,
    });
    mockWsInstance.simulateOpen();
    statusSpy.mockClear();
    mockWsInstance.simulateClose(1006);
    expect(statusSpy).toHaveBeenCalledWith("reconnecting");
    expect(statusSpy).not.toHaveBeenCalledWith("authFailed");
    transport.close();
    vi.useRealTimers();
  });

  it("reconnects immediately after 4001 close without waiting", async () => {
    vi.useFakeTimers();

    // Track each reconnect attempt's URL
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: vi.fn(),
      discoverServerUrl: async () => "ws://localhost:1234",
    });

    mockWsInstance.simulateOpen();

    // Grab initial reconnect delay by triggering a 4001 close (immediate reconnect)
    const firstInstance = mockWsInstance;
    firstInstance.simulateClose(4001);

    // With immediate=true, the reconnect fires at delay=0
    await vi.advanceTimersByTimeAsync(0);

    // A new WebSocket should have been created immediately
    const secondInstance = mockWsInstance;
    expect(secondInstance).not.toBe(firstInstance);

    transport.close();
    vi.useRealTimers();
  });

  it("calls discoverServerUrl on auth failure reconnect", async () => {
    vi.useFakeTimers();
    let discoverCalled = false;
    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: vi.fn(),
      discoverServerUrl: async () => {
        discoverCalled = true;
        return "ws://localhost:5678";
      },
    });

    mockWsInstance.simulateOpen();
    mockWsInstance.simulateClose(4001);

    // Auth failure triggers immediate reconnect (delay=0)
    await vi.advanceTimersByTimeAsync(0);

    expect(discoverCalled).toBe(true);

    transport.close();
    vi.useRealTimers();
  });

  it("falls back to backoff delay after MAX_IMMEDIATE_AUTH_RETRIES consecutive 4001s", async () => {
    // This test simulates a server that persistently rejects every connection
    // with 4001 (never sending onopen). After 3 immediate retries the client
    // must fall back to backoff so it doesn't spin in a tight loop.
    vi.useFakeTimers();

    const instances: MockWebSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      new Proxy(MockWebSocket, {
        construct(Target) {
          const instance = new Target();
          mockWsInstance = instance;
          instances.push(instance);
          return instance;
        },
      }),
    );

    const transport = createWsTransport("ws://localhost:1234", {
      onStatusChange: vi.fn(),
    });

    // Initial connection opens successfully, then the server starts rejecting.
    instances[0].simulateOpen();

    // Fail #1: immediate retry (counter 0→1)
    instances[0].simulateClose(4001);
    await vi.advanceTimersByTimeAsync(0); // instance[1] created, no open
    // Fail #2: immediate retry (counter 1→2)
    instances[1].simulateClose(4001);
    await vi.advanceTimersByTimeAsync(0); // instance[2] created, no open
    // Fail #3: immediate retry (counter 2→3)
    instances[2].simulateClose(4001);
    await vi.advanceTimersByTimeAsync(0); // instance[3] created, no open

    // Fail #4: counter is now at MAX_IMMEDIATE_AUTH_RETRIES (3), so the next
    // reconnect must use backoff, not delay=0.
    const countBefore = instances.length;
    instances[3].simulateClose(4001);
    // Advancing by 0 ms must NOT create a new instance.
    await vi.advanceTimersByTimeAsync(0);
    expect(instances.length).toBe(countBefore);

    transport.close();
    vi.useRealTimers();
  });
});

/**
 * Browser-faithful socket: send() throws while CONNECTING and silently
 * discards while CLOSING/CLOSED, matching the WebSocket spec. The silent
 * drop is what orphans an RPC that resumes onto a dead socket.
 */
class LifecycleSocket {
  static instances: LifecycleSocket[] = [];
  static readonly OPEN = 1;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readyState = 0;
  binaryType = "";

  constructor() {
    LifecycleSocket.instances.push(this);
  }

  send(raw: string | ArrayBuffer): void {
    if (this.readyState === 0) throw new Error("InvalidStateError: socket is CONNECTING");
    if (this.readyState !== LifecycleSocket.OPEN) return;
    if (typeof raw !== "string") return;
    const request = JSON.parse(raw) as { id: string; method?: string };
    const result = request.method === "workspace.list" ? [{ id: "fixture" }] : null;
    queueMicrotask(() =>
      this.onmessage?.({ data: JSON.stringify({ id: request.id, result }) }),
    );
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  fail(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "fixture failure" });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

describe("RPC readiness across reconnects (issue #1733)", () => {
  let transport: ReturnType<typeof createWsTransport>;

  function settleSpy(promise: Promise<unknown>): { state: string } {
    const spy = { state: "pending" };
    void promise.then(
      () => { spy.state = "resolved"; },
      () => { spy.state = "rejected"; },
    );
    return spy;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    LifecycleSocket.instances = [];
    vi.stubGlobal("WebSocket", LifecycleSocket);
    transport = createWsTransport("ws://fixture.invalid");
  });

  afterEach(() => {
    transport.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles an RPC waiting during a failed connecting attempt after the next socket opens", async () => {
    LifecycleSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    await expect(transport.listWorkspaces()).resolves.toEqual([{ id: "fixture" }]);

    LifecycleSocket.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1100);
    expect(LifecycleSocket.instances).toHaveLength(2);

    const original = settleSpy(transport.listWorkspaces());
    LifecycleSocket.instances[1]!.fail();
    await vi.advanceTimersByTimeAsync(2100);
    expect(LifecycleSocket.instances).toHaveLength(3);
    LifecycleSocket.instances[2]!.open();
    await vi.advanceTimersByTimeAsync(0);

    await expect(transport.listWorkspaces()).resolves.toEqual([{ id: "fixture" }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(original.state).not.toBe("pending");
  });

  it("keeps a waiting RPC alive across consecutive failed reconnect attempts", async () => {
    LifecycleSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    LifecycleSocket.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1100);
    expect(LifecycleSocket.instances).toHaveLength(2);

    const waiting = settleSpy(transport.listWorkspaces());
    LifecycleSocket.instances[1]!.fail();
    await vi.advanceTimersByTimeAsync(2100);
    LifecycleSocket.instances[2]!.fail();
    await vi.advanceTimersByTimeAsync(4100);
    expect(LifecycleSocket.instances).toHaveLength(4);

    LifecycleSocket.instances[3]!.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting.state).toBe("resolved");
  });

  it("rejects an RPC waiting for readiness when the transport is closed", async () => {
    LifecycleSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    LifecycleSocket.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1100);
    expect(LifecycleSocket.instances).toHaveLength(2);

    const waiting = settleSpy(transport.listWorkspaces());
    transport.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting.state).toBe("rejected");
  });

  it("rejects RPCs issued after close instead of queueing them forever", async () => {
    LifecycleSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    transport.close();

    const late = settleSpy(transport.listWorkspaces());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(late.state).toBe("rejected");
  });

  it("settles a binary RPC waiting during a failed connecting attempt after the next socket opens", async () => {
    LifecycleSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    LifecycleSocket.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1100);
    expect(LifecycleSocket.instances).toHaveLength(2);

    const waiting = settleSpy(
      transport.saveClipboardFile(new ArrayBuffer(4), "image/png", "clip.png"),
    );
    LifecycleSocket.instances[1]!.fail();
    await vi.advanceTimersByTimeAsync(2100);
    LifecycleSocket.instances[2]!.open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting.state).toBe("resolved");
  });

  it("does not open a new socket or re-arm readiness when close() lands mid-reconnect", async () => {
    transport.close();
    let releaseDiscovery: (() => void) | null = null;
    transport = createWsTransport("ws://fixture.invalid", {
      discoverServerUrl: () =>
        new Promise<string>((resolve) => {
          releaseDiscovery = () => resolve("ws://fixture.invalid");
        }),
    });

    // instances[0] belongs to the beforeEach transport closed above.
    LifecycleSocket.instances[1]!.open();
    await vi.advanceTimersByTimeAsync(0);
    LifecycleSocket.instances[1]!.fail();
    // Reconnect callback fires and suspends inside discoverServerUrl.
    await vi.advanceTimersByTimeAsync(1100);

    transport.close();
    releaseDiscovery!();
    await vi.advanceTimersByTimeAsync(60_000);

    // No post-close connect() may run: no new socket, and `ready` stays
    // rejected so late RPCs fail fast instead of parking forever.
    expect(LifecycleSocket.instances).toHaveLength(2);
    const late = settleSpy(transport.listWorkspaces());
    await vi.advanceTimersByTimeAsync(0);
    expect(late.state).toBe("rejected");
  });

  it("rejects a binary RPC waiting for readiness when the transport is closed", async () => {
    LifecycleSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    LifecycleSocket.instances[0]!.fail();
    await vi.advanceTimersByTimeAsync(1100);

    const waiting = settleSpy(
      transport.saveClipboardFile(new ArrayBuffer(4), "image/png", "clip.png"),
    );
    transport.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waiting.state).toBe("rejected");
  });
});

