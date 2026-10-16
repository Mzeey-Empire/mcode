import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { probeActionPort } from "../action-port-probe.js";

const servers: NodeNet.Server[] = [];

async function listen(host: string): Promise<number> {
  const server = NodeNet.createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port: 0, ipv6Only: host === "::1" }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return address.port;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("probeActionPort", () => {
  it("probes IPv4 and wildcard hosts and detects a listener closing", async () => {
    const port = await listen("127.0.0.1");
    for (const host of ["127.0.0.1", "0.0.0.0", "localhost"] as const) {
      expect(await probeActionPort({ host, port, url: `http://localhost:${port}/` })).toBe(true);
    }
    await new Promise<void>((resolve) => servers[0].close(() => resolve()));
    expect(await probeActionPort({ host: "127.0.0.1", port, url: `http://localhost:${port}/` })).toBe(false);
  });

  it("probes IPv6-only loopback through literal, wildcard and localhost hosts", async (context) => {
    let port: number;
    try { port = await listen("::1"); }
    catch (error) {
      if (error instanceof Error && "code" in error && ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(String(error.code))) {
        context.skip(`IPv6 loopback unavailable: ${String(error.code)}`);
        return;
      }
      throw error;
    }
    for (const host of ["::1", "::", "localhost"] as const) {
      expect(await probeActionPort({ host, port, url: `http://[::1]:${port}/` })).toBe(true);
    }
    expect(await probeActionPort({ host: "127.0.0.1", port, url: `http://127.0.0.1:${port}/` })).toBe(false);
  });
});
