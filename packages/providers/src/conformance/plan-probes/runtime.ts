import type * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import { z } from "zod";

/** Providers and scenarios accepted by the research runner, not factory capabilities. */
export const providerSchema = z.enum(["claude", "codex", "cursor", "copilot", "devin", "opencode"]);
/** Research scenario names shared by capture metadata and the command boundary. */
export const scenarioSchema = z.enum(["plan", "questions", "file-identity", "fence", "questions-free-text", "questions-decline", "questions-cancel", "questions-interrupt", "questions-process-exit"]);
/** A raw envelope stays local until explicitly reviewed and projected. */
export interface RawMessage {
  kind: "request" | "reply" | "event";
  direction: "sent" | "received";
  operation: string;
  exchange?: string | number;
  payload: unknown;
}
/** Recorded termination distinguishes service failure from a completed probe. */
export type ProbeEnd = { kind: "completed" | "interrupted" | "timeout" | "blocked" } | { kind: "process-exit"; code: number | null; signal: NodeJS.Signals | null };
/** Exact installed versions, independently of minimum supported versions. */
export interface CaptureVersion { cliVersion: string; protocolVersion: string; sdk: { name: string; version: string } | null }
/** Only the runner owns processes, raw files, and the deadline. */
export interface ProbeContext {
  provider: z.infer<typeof providerSchema>;
  scenario: z.infer<typeof scenarioSchema>;
  fixtureRepo: string;
  providerHome: string;
  rawDirectory: string;
  signal: AbortSignal;
  record(message: RawMessage): void;
  version(version: CaptureVersion): void;
  onCleanup(cleanup: () => Promise<void>): void;
  spawn(command: string, args: string[], env?: NodeJS.ProcessEnv): NodeChildProcess.ChildProcessWithoutNullStreams;
  mayWrite(path: string): boolean;
}

/** Fixed nested-fence challenge; only computed booleans survive sanitization. */
export const FENCE_TEXT = "````mcode-plan\n# Fixture plan\n\n1. Add a greeting.\n\n```ts\nconst greeting = 'hello';\n```\n````";
/** Prompts do not authorize edits outside the fixture or provider run directory. */
export function promptFor(context: ProbeContext): string {
  const boundary = `Work only in ${context.fixtureRepo}. Do not run commands or change source files. Any plan file must be under ${context.providerHome}. Do not use subagents.`;
  if (context.scenario === "fence") return `${boundary}\nReply with exactly this text, preserving every backtick and newline:\n${FENCE_TEXT}`;
  if (context.scenario.startsWith("questions")) return `${boundary}\nUse your native question tool to ask me to choose a greeting style, with Brief and Detailed options. Wait for the answer before writing a short plan. Do not choose for me.`;
  return `${boundary}\nPlan a new greet.ts exporting greet(): string returning 'Hello fixture'. No clarification or repository inspection is needed. Do not ask questions. Do not implement it. Use your native plan output and exit-plan tool if available. Include a title, one step, and a test. Keep it under 150 words.`;
}
/** Content equality is measured before private response text is removed. */
export function recordFence(context: ProbeContext, text: string): void {
  context.record({ kind: "event", direction: "received", operation: "probe/fence", payload: { exact: text.trim() === FENCE_TEXT, openerExact: text.includes("````mcode-plan\n"), nestedFenceIntact: text.includes("```ts\nconst greeting = 'hello';\n```"), closerExact: text.trimEnd().endsWith("\n````") } });
}

/** Read the installed SDK build rather than the dependency range in package.json. */
export function installedSdkVersion(name: "@github/copilot-sdk" | "@anthropic-ai/claude-agent-sdk"): string {
  const file = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../node_modules", name, "package.json");
  return packageVersionSchema.parse(JSON.parse(NodeFS.readFileSync(file, "utf8"))).version;
}
const packageVersionSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });

/** Resolve an existing path through links before authorizing writes beneath a root. */
export function containedPath(root: string, target: string): boolean {
  let existing = NodePath.resolve(target);
  while (!NodeFS.existsSync(existing)) {
    const parent = NodePath.dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  const realRoot = NodeFS.realpathSync(root);
  const realTarget = NodePath.resolve(NodeFS.realpathSync(existing), NodePath.relative(existing, NodePath.resolve(target)));
  const relative = NodePath.relative(realRoot, realTarget);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

/** SDK and command version checks share the same bounded, owned-process route. */
export async function commandOutput(context: ProbeContext, command: string, args: string[]): Promise<string> {
  const child = context.spawn(command, args);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`Command exited ${code}`)));
  });
}

/** Global configuration is read only for hashing, never copied into a probe home. */
export function hygieneSnapshot(): { configs: Record<string, string | null>; bookkeeping: string | null; plans: Record<string, string> } {
  const home = NodeOS.homedir();
  const configNames = [".codex/config.toml", ".claude/settings.json", ".claude/settings.local.json", ".cursor/cli-config.json", ".copilot/config.json", ".copilot/mcp-config.json", ".config/devin/config.json", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", "AppData/Roaming/devin/cli/trusted_workspaces.json", "AppData/Roaming/devin/cli/app_state.json"];
  const configs = Object.fromEntries(configNames.map((name) => [name, hashFile(NodePath.join(home, name))]));
  const plans: Record<string, string> = {};
  for (const folder of [".claude/plans", ".cursor/plans", ".copilot/session-state", ".config/devin/plans", ".local/share/devin/plans", "AppData/Roaming/devin/cli/plans", ".opencode/plans", ".local/share/opencode/plans"]) {
    for (const [file, hash] of Object.entries(listFiles(NodePath.join(home, folder)))) {
      if (/\.md$/i.test(file)) plans[NodePath.join(home, folder, file)] = hash;
    }
  }
  return { configs, bookkeeping: hashFile(NodePath.join(home, ".claude.json")), plans };
}

function hashFile(file: string): string | null {
  return NodeFS.existsSync(file) ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex") : null;
}

/** List regular files only; never follow a junction into another checkout or home. */
export function listFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!NodeFS.existsSync(root)) return files;
  function visit(directory: string, depth: number): void {
    if (depth > 12) throw new Error("Filesystem observation depth exceeded");
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) {
        const stat = NodeFS.statSync(path);
        files[NodePath.relative(root, path)] = /\.md$/i.test(path) ? hashFile(path) ?? "" : `${stat.size}:${stat.mtimeMs}`;
      }
    }
  }
  visit(root, 0);
  return files;
}
