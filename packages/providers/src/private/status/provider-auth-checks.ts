/**
 * Sign-in checks behind each adapter's `describeStatus`. A check returns
 * `signed_out` only when the provider positively says so. A timeout, crash,
 * missing binary, or unrecognised answer returns `unknown`, which the bell
 * never shows, so a broken probe cannot tell a signed-in user to sign in.
 */
import type { ProviderStatusFacts } from "@mcode/contracts";
import type { CliStatusOutcome, CliStatusRunner } from "./cli-status-runner.js";

const SIGNED_IN: ProviderStatusFacts = { auth: { state: "signed_in" } };
const UNKNOWN: ProviderStatusFacts = { auth: { state: "unknown" } };

function signedOut(argv: [string, ...string[]]): ProviderStatusFacts {
  return { auth: { state: "signed_out", signIn: { kind: "terminal", argv } } };
}

function factsFromOutput(
  outcome: CliStatusOutcome,
  signedInPattern: RegExp,
  signedOutPattern: RegExp,
  signIn: [string, ...string[]],
): ProviderStatusFacts {
  if (outcome.kind !== "exited") return UNKNOWN;
  if (signedOutPattern.test(outcome.output)) return signedOut(signIn);
  if (signedInPattern.test(outcome.output)) return SIGNED_IN;
  return UNKNOWN;
}

/** Codex: `codex login status` prints "Logged in using ..." or "Not logged in". */
export async function describeCodexAuth(run: CliStatusRunner, cliPath: string): Promise<ProviderStatusFacts> {
  const outcome = await run(cliPath, ["login", "status"]);
  return factsFromOutput(outcome, /^\s*Logged in\b/m, /^\s*Not logged in\b/m, ["codex", "login"]);
}

/** Cursor: `cursor-agent status` prints "Logged in as <email>" or "Not logged in". Tries each candidate binary. */
export async function describeCursorAuth(
  run: CliStatusRunner,
  binaries: readonly string[],
): Promise<ProviderStatusFacts> {
  for (const binary of binaries) {
    const outcome = await run(binary, ["status"]);
    if (outcome.kind === "failed") continue;
    return factsFromOutput(outcome, /\bLogged in as\b/, /^\s*Not logged in\b/m, ["cursor-agent", "login"]);
  }
  return UNKNOWN;
}

/**
 * OpenCode fronts many upstreams, so it is signed out only when `opencode auth list`
 * reports zero stored credentials and no credential environment variables.
 */
export async function describeOpenCodeAuth(run: CliStatusRunner, cliPath: string): Promise<ProviderStatusFacts> {
  const outcome = await run(cliPath, ["auth", "list"]);
  if (outcome.kind !== "exited" || outcome.code !== 0) return UNKNOWN;
  const stored = countBefore(outcome.output, /(\d+)\s+credentials?\b/);
  if (stored === null) return UNKNOWN;
  const fromEnv = countBefore(outcome.output, /(\d+)\s+environment variables?\b/) ?? 0;
  return stored + fromEnv > 0 ? SIGNED_IN : signedOut(["opencode", "auth", "login"]);
}

function countBefore(output: string, pattern: RegExp): number | null {
  const match = pattern.exec(output);
  return match ? Number(match[1]) : null;
}

/** The subset of the Copilot SDK `auth.getStatus` answer the check reads. */
export interface CopilotAuthStatus {
  isAuthenticated: boolean;
}

/** Copilot: the SDK answers `isAuthenticated`; a failed or malformed call is unknown. */
export async function describeCopilotAuth(
  getAuthStatus: () => Promise<CopilotAuthStatus>,
): Promise<ProviderStatusFacts> {
  try {
    const status = await getAuthStatus();
    if (status.isAuthenticated === true) return SIGNED_IN;
    if (status.isAuthenticated === false) return signedOut(["copilot", "login"]);
    return UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

const CLAUDE_ENV_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const CLAUDE_THIRD_PARTY_BACKENDS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"] as const;

/**
 * Claude: an Anthropic credential variable means signed in. Otherwise
 * `claude auth status` answers with JSON whose `loggedIn` flag covers every
 * login store (keychain, credentials file, apiKeyHelper). Bedrock and Vertex
 * authenticate through their cloud, which Mcode cannot see, so they are unknown.
 */
export async function describeClaudeAuth(
  run: CliStatusRunner,
  cliPath: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ProviderStatusFacts> {
  if (CLAUDE_ENV_CREDENTIALS.some((name) => env[name]?.trim())) return SIGNED_IN;
  if (CLAUDE_THIRD_PARTY_BACKENDS.some((name) => isTruthyFlag(env[name]))) return UNKNOWN;
  const outcome = await run(cliPath, ["auth", "status"]);
  if (outcome.kind !== "exited") return UNKNOWN;
  const loggedIn = readLoggedInFlag(outcome.output);
  if (loggedIn === true) return SIGNED_IN;
  // Running `claude` with no arguments starts its own login flow.
  if (loggedIn === false) return signedOut(["claude"]);
  return UNKNOWN;
}

function readLoggedInFlag(output: string): boolean | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(output.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || !("loggedIn" in parsed)) return null;
    return typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null;
  } catch {
    return null;
  }
}

function isTruthyFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" && normalized !== "0" && normalized !== "false";
}

