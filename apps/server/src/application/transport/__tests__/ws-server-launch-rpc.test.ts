import "reflect-metadata";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// The recorder is a module singleton read from the environment, so the test imports a fresh server module graph,
// which takes several seconds on a cold transform.
it("records text, abandoned upload, binary upload and shutdown answers in the launch window, naming unregistered methods unknown", { timeout: 30_000 }, async () => {
  vi.stubEnv("MCODE_LAUNCH_ID", "d98138cd-a571-49b8-ae76-8ec6507c3201");
  vi.resetModules();
  const { launchTelemetry } = await import("../../../runtime/diagnostics/launch-telemetry.js");
  const { createWsServer } = await import("../ws-server.js");
  const server = createWsServer({
    authToken: "test-token",
    shutdown: () => undefined,
    agentService: { runtimeAccess: () => ({ activeCount: () => 0 }) },
    terminalService: { disconnectClient: () => undefined },
    resolveBrowserAutomationHostAuthorization: () => null,
  } as never);
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind");
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/?token=test-token`);
  try {
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const nextAnswer = () => new Promise<Buffer>((resolve) => client.once("message", (data) => resolve(data as Buffer)));
    launchTelemetry.listen();

    const textAnswer = nextAnswer();
    client.send(JSON.stringify({ id: "1", method: "attacker.chosen-label", params: {} }));
    const text = await textAnswer;
    const abandonedAnswer = nextAnswer();
    client.send(JSON.stringify({ type: "binary-upload", id: "2", method: "clipboard.saveFile", meta: {} }));
    client.send(JSON.stringify({ type: "binary-upload", id: "3", method: "clipboard.saveFile", meta: {} }));
    const abandoned = await abandonedAnswer;
    const uploadAnswer = nextAnswer();
    client.send(Buffer.from([1, 2, 3]));
    const upload = await uploadAnswer;
    await server.stopAdmissionAndDrain();
    const shutdownAnswer = nextAnswer();
    client.send(JSON.stringify({ id: "4", method: "workspace.list", params: {} }));
    const shutdown = await shutdownAnswer;

    const snapshot = await launchTelemetry.close();
    expect(snapshot?.rpcs).toEqual([
      { method: "unknown", startAt: expect.any(Number), durationMs: expect.any(Number), responseBytes: text.byteLength },
      { method: "clipboard.saveFile", startAt: expect.any(Number), durationMs: expect.any(Number), responseBytes: abandoned.byteLength },
      { method: "clipboard.saveFile", startAt: expect.any(Number), durationMs: expect.any(Number), responseBytes: upload.byteLength },
      { method: "workspace.list", startAt: expect.any(Number), durationMs: expect.any(Number), responseBytes: shutdown.byteLength },
    ]);
    expect(snapshot?.unansweredRpcs).toEqual([]);
  } finally {
    client.terminate();
    server.httpServer.closeAllConnections();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
});
