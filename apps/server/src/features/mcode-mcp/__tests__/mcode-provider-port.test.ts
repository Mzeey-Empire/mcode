import { describe, expect, it, vi } from "vitest";
import { McodeProviderPort } from "../mcode-provider-port.js";
import { McodeSessionAuthority } from "../mcode-session-authority.js";

const request = { providerId: "claude", sessionId: "session-a", threadId: "thread-a", threadControl: true };

function createPort(options: { endpoint?: string | null; browser?: boolean } = {}) {
  const authority = new McodeSessionAuthority();
  const server = {
    endpoint: vi.fn(() => (options.endpoint === undefined ? "http://127.0.0.1:4000/mcp/mcode" : options.endpoint)),
    closeSession: vi.fn(async () => undefined),
  };
  const port = new McodeProviderPort({
    authority,
    server: () => server,
    isBrowserConfigured: () => options.browser ?? true,
  });
  return { authority, server, port };
}

describe("McodeProviderPort", () => {
  it("returns the endpoint and a token that resolves to the attached session", async () => {
    const { authority, port } = createPort();

    const attachment = await port.attach(request);

    expect(attachment).toMatchObject({
      serverName: "mcode",
      url: "http://127.0.0.1:4000/mcp/mcode",
      toolkits: { browser: true, threadControl: true, visuals: true },
    });
    expect(authority.resolve(attachment?.token ?? "")).toMatchObject({ sessionId: "session-a", threadId: "thread-a" });
  });

  it("attaches nothing before the server is listening", async () => {
    const { authority, port } = createPort({ endpoint: null });

    expect(await port.attach(request)).toBeNull();
    expect(authority.credential("session-a")).toBeUndefined();
  });

  it("attaches nothing when neither toolkit applies, and reports which toolkits do", async () => {
    const { port } = createPort({ browser: false });

    expect(await port.attach({ ...request, threadControl: false })).toBeNull();
    expect(await port.attach(request)).toMatchObject({ toolkits: { browser: false, threadControl: true, visuals: true } });
  });

  it("revokes the token and ends in-flight requests when the session closes", async () => {
    const { authority, server, port } = createPort();
    const attachment = await port.attach(request);

    await port.close("session-a");

    expect(authority.resolve(attachment?.token ?? "")).toBeNull();
    expect(server.closeSession).toHaveBeenCalledWith("session-a");
  });

  it.each([true, false])("attaches visuals only with thread control = %s", async (threadControl) => {
    const { port } = createPort({ browser: true });
    const attachment = await port.attach({ ...request, threadControl });
    expect(attachment?.toolkits.visuals).toBe(threadControl);
  });
});
