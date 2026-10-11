import { describe, expect, it, vi } from "vitest";
import type { CliStatusOutcome, CliStatusRunner } from "../cli-status-runner.js";
import {
  describeClaudeAuth,
  describeCodexAuth,
  describeCopilotAuth,
  describeCursorAuth,
  describeOpenCodeAuth,
} from "../provider-auth-checks.js";

const SIGNED_IN = { auth: { state: "signed_in" } };
const UNKNOWN = { auth: { state: "unknown" } };

function signedOut(...argv: string[]) {
  return { auth: { state: "signed_out", signIn: { kind: "terminal", argv } } };
}

function exited(output: string, code = 0): CliStatusRunner {
  return vi.fn(async (): Promise<CliStatusOutcome> => ({ kind: "exited", code, output }));
}

const failed: CliStatusRunner = async () => ({ kind: "failed" });

describe("describeCodexAuth", () => {
  it("reads a ChatGPT login as signed in", async () => {
    const run = exited("Logged in using ChatGPT\n");
    await expect(describeCodexAuth(run, "codex")).resolves.toEqual(SIGNED_IN);
    expect(run).toHaveBeenCalledWith("codex", ["login", "status"]);
  });

  it("reads 'Not logged in' with exit 1 as signed out", async () => {
    await expect(describeCodexAuth(exited("Not logged in\n", 1), "codex"))
      .resolves.toEqual(signedOut("codex", "login"));
  });

  it("treats unrecognised output and a failed run as unknown", async () => {
    await expect(describeCodexAuth(exited("error: unexpected argument 'status'", 2), "codex"))
      .resolves.toEqual(UNKNOWN);
    await expect(describeCodexAuth(failed, "codex")).resolves.toEqual(UNKNOWN);
  });
});

describe("describeCursorAuth", () => {
  it("reads 'Logged in as' as signed in", async () => {
    await expect(describeCursorAuth(exited("✓ Logged in as someone@example.test\n"), ["cursor-agent"]))
      .resolves.toEqual(SIGNED_IN);
  });

  it("reads 'Not logged in' as signed out even with exit 0", async () => {
    await expect(describeCursorAuth(exited("Not logged in\n"), ["cursor-agent"]))
      .resolves.toEqual(signedOut("cursor-agent", "login"));
  });

  it("treats unrecognised output as unknown", async () => {
    await expect(describeCursorAuth(exited("Checking...\n"), ["cursor-agent"])).resolves.toEqual(UNKNOWN);
  });

  it("falls through to the next binary when one cannot run", async () => {
    const run = vi.fn<CliStatusRunner>(async (binary) =>
      binary === "agent" ? { kind: "exited", code: 0, output: "Not logged in" } : { kind: "failed" });
    await expect(describeCursorAuth(run, ["cursor-agent", "agent"]))
      .resolves.toEqual(signedOut("cursor-agent", "login"));
    await expect(describeCursorAuth(failed, ["cursor-agent", "agent"])).resolves.toEqual(UNKNOWN);
  });
});

describe("describeOpenCodeAuth", () => {
  const credentialsBlock = (count: number) => `┌  Credentials /home/u/.local/share/opencode/auth.json\n│\n└  ${count} credentials\n`;

  it("reads stored credentials as signed in", async () => {
    await expect(describeOpenCodeAuth(exited(credentialsBlock(2)), "opencode")).resolves.toEqual(SIGNED_IN);
  });

  it("reads credential environment variables as signed in", async () => {
    const output = `${credentialsBlock(0)}\n┌  Environment\n●  Anthropic ANTHROPIC_API_KEY\n└  1 environment variable\n`;
    await expect(describeOpenCodeAuth(exited(output), "opencode")).resolves.toEqual(SIGNED_IN);
  });

  it("reads zero credentials and no environment as signed out", async () => {
    await expect(describeOpenCodeAuth(exited(credentialsBlock(0)), "opencode"))
      .resolves.toEqual(signedOut("opencode", "auth", "login"));
  });

  it("treats unrecognised output, a non-zero exit, and a failed run as unknown", async () => {
    await expect(describeOpenCodeAuth(exited("Usage: opencode auth"), "opencode")).resolves.toEqual(UNKNOWN);
    await expect(describeOpenCodeAuth(exited(credentialsBlock(0), 1), "opencode")).resolves.toEqual(UNKNOWN);
    await expect(describeOpenCodeAuth(failed, "opencode")).resolves.toEqual(UNKNOWN);
  });
});

describe("describeCopilotAuth", () => {
  it("maps the SDK auth answer", async () => {
    await expect(describeCopilotAuth(async () => ({ isAuthenticated: true }))).resolves.toEqual(SIGNED_IN);
    await expect(describeCopilotAuth(async () => ({ isAuthenticated: false })))
      .resolves.toEqual(signedOut("copilot", "login"));
  });

  it("treats a failed call or a malformed answer as unknown", async () => {
    await expect(describeCopilotAuth(async () => { throw new Error("timed out"); })).resolves.toEqual(UNKNOWN);
    const malformed = JSON.parse("{}") as { isAuthenticated: boolean };
    await expect(describeCopilotAuth(async () => malformed)).resolves.toEqual(UNKNOWN);
  });
});

describe("describeClaudeAuth", () => {
  it("reads loggedIn true or an API key as signed in", async () => {
    const run = exited('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n');
    await expect(describeClaudeAuth(run, "claude", {})).resolves.toEqual(SIGNED_IN);
    expect(run).toHaveBeenCalledWith("claude", ["auth", "status"]);
    await expect(describeClaudeAuth(failed, "claude", { ANTHROPIC_API_KEY: "placeholder" }))
      .resolves.toEqual(SIGNED_IN);
  });

  it("reads loggedIn false with exit 1 as signed out", async () => {
    const run = exited('{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n', 1);
    await expect(describeClaudeAuth(run, "claude", {})).resolves.toEqual(signedOut("claude"));
  });

  it("treats a failed run, unparseable output, or a cloud backend as unknown", async () => {
    await expect(describeClaudeAuth(failed, "claude", {})).resolves.toEqual(UNKNOWN);
    await expect(describeClaudeAuth(exited("error: unknown command 'auth'", 1), "claude", {}))
      .resolves.toEqual(UNKNOWN);
    await expect(describeClaudeAuth(exited('{"loggedIn": "yes"}'), "claude", {})).resolves.toEqual(UNKNOWN);
    const run = exited('{"loggedIn": false}', 1);
    await expect(describeClaudeAuth(run, "claude", { CLAUDE_CODE_USE_BEDROCK: "1" })).resolves.toEqual(UNKNOWN);
    expect(run).not.toHaveBeenCalled();
  });
});
