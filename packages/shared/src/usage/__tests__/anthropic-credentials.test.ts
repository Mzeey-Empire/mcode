import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAnthropicOauthToken } from "../anthropic-credentials.js";

// Hoisted mock so execFile can be replaced per-test for the darwin path
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

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

    // Replace execFile for this test only to avoid spawning the real `security` binary
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        cb: unknown,
      ) => {
        (cb as (err: Error | null, stdout: string, stderr: string) => void)(
          null,
          mockJson,
          "",
        );
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await readAnthropicOauthToken("darwin");
    expect(result).toEqual({ accessToken: "sk-mac", expiresAt: 1 });
  });
});
