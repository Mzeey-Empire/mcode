import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAnthropicOauthToken } from "../anthropic-credentials.js";

// vi.mock is hoisted to the top of the file, so the mock factory cannot
// reference variables declared with const/let. vi.hoisted runs before the
// hoist and makes the mock available to both the factory and test bodies.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("readAnthropicOauthToken", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "mcode-cred-"));
    vi.stubEnv("HOME", tmpHome);
    vi.stubEnv("USERPROFILE", tmpHome);
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads plaintext credentials on linux", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat-test",
          expiresAt: 9999999999999,
          refreshToken: "rt-x",
        },
      }),
    );

    const token = await readAnthropicOauthToken("linux");
    expect(token).toEqual({
      accessToken: "sk-ant-oat-test",
      expiresAt: 9999999999999,
    });
  });

  it("returns null when the credentials file is missing", async () => {
    expect(await readAnthropicOauthToken("linux")).toBeNull();
  });

  it("returns null when the file is malformed JSON", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    writeFileSync(join(tmpHome, ".claude", ".credentials.json"), "{not json");
    expect(await readAnthropicOauthToken("linux")).toBeNull();
  });

  it("invokes `security` on darwin and parses its stdout", async () => {
    const mockJson = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-mac", expiresAt: 1, refreshToken: "r" },
    });

    // Drive execFile synchronously so the promise resolves with the mock output
    execFileMock.mockImplementation(
      (_cmd: unknown, _args: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, mockJson);
      },
    );

    const result = await readAnthropicOauthToken("darwin");
    expect(result).toEqual({ accessToken: "sk-mac", expiresAt: 1 });
  });
});
