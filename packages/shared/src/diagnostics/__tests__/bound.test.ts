import { describe, expect, it } from "vitest";
import { boundPayload } from "../internal/bound.js";

describe("boundPayload", () => {
  it("redacts secret-shaped keys in any casing while keeping token counters", () => {
    const bounded = boundPayload({
      accessToken: "a1",
      client_secret: "a2",
      "x-api-key": "a3",
      Cookie: "a4",
      tokensIn: 120,
      maxTokens: 4096,
    });

    expect(bounded).toEqual({
      accessToken: "[redacted]",
      client_secret: "[redacted]",
      "x-api-key": "[redacted]",
      Cookie: "[redacted]",
      tokensIn: 120,
      maxTokens: 4096,
    });
  });

  it("redacts well-known provider token formats inside free text", () => {
    const secrets = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "xoxb-1234567890-abcdefghij",
      "AKIAABCDEFGHIJKLMNOP",
    ];
    const bounded = String(boundPayload("spawn failed with " + secrets.join(" and ")));

    for (const secret of secrets) expect(bounded).not.toContain(secret);
    expect(bounded).toContain("spawn failed with [redacted]");
  });

  it("redacts the credential of an Authorization header in any scheme", () => {
    const stderr = [
      "> GET /info/refs HTTP/1.1",
      "> Authorization: Basic dXNlcjpodW50ZXIy",
      "> Proxy-Authorization: token plainProxySecret",
      "< HTTP/1.1 401",
    ].join("\n");
    const bounded = String(boundPayload(stderr));

    expect(bounded).not.toContain("dXNlcjpodW50ZXIy");
    expect(bounded).not.toContain("plainProxySecret");
    expect(bounded).toContain("< HTTP/1.1 401");
  });

  it("redacts credentials embedded in a URL", () => {
    const bounded = String(boundPayload(
      "fatal: unable to access 'https://deploy:hunter2pass@git.example.com/org/repo.git/': 403",
    ));

    expect(bounded).not.toContain("hunter2pass");
    expect(bounded).toContain("https://[redacted]@git.example.com/org/repo.git/");
  });
});
