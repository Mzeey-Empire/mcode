import type {
  CodexProviderBoundary,
  ClaudeProviderBoundary,
  CursorProviderBoundary,
  DevinProviderBoundary,
  ProviderBoundary,
  ProviderFactoryInput,
} from "./factory-types.js";
import { createProviderBoundary } from "./private/factory.js";
import { createCursorAcpProvider, createDevinAcpProvider } from "./private/protocols/acp.js";
import { CodexProvider } from "./private/codex/codex-provider.js";
import { ClaudeProvider } from "./private/claude/claude-provider.js";

/** Prepares the Claude Provider boundary without inspecting or spawning its CLI. */
export function createClaudeProvider(input: ProviderFactoryInput): ClaudeProviderBoundary {
  createProviderBoundary("claude", [], input);
  if (typeof input.claude?.createForker !== "function") throw new TypeError("Claude Provider createForker port is required");
  for (const method of ["isConfigured", "issue", "refresh", "release", "revokeCredential"] as const) {
    if (typeof input.host.browser[method] !== "function") throw new TypeError(`Claude browser ${method} port is required`);
  }
  return new ClaudeProvider(input.host, input.configuration, input.claude);
}

/** Prepares the Codex Provider boundary without inspecting or spawning its CLI. */
export function createCodexProvider(input: ProviderFactoryInput): CodexProviderBoundary {
  createProviderBoundary("codex", [], input);
  if (!input.codex) throw new TypeError("Codex Provider ports are required");
  validateCodexPorts(input.codex);
  return new CodexProvider(input.host, input.codex, input.configuration.idleSessionTtlMs);
}

/** Prepares the Copilot Provider boundary without inspecting or spawning its CLI. */
export function createCopilotProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createProviderBoundary("copilot", [], input);
}

/** Prepares the Cursor Provider boundary with private generic ACP machinery. */
export function createCursorProvider(input: ProviderFactoryInput): CursorProviderBoundary {
  return createCursorAcpProvider(input);
}

/** Prepares the Devin Provider boundary with private generic ACP machinery. */
export function createDevinProvider(input: ProviderFactoryInput): DevinProviderBoundary {
  return createDevinAcpProvider(input);
}

/** Prepares the OpenCode Provider boundary without inspecting or spawning its CLI. */
export function createOpencodeProvider(input: ProviderFactoryInput): ProviderBoundary {
  return createProviderBoundary("opencode", ["build", "plan", "permissions", "session-eviction"], input);
}

function validateCodexPorts(ports: NonNullable<ProviderFactoryInput["codex"]>): void {
  const methods = [
    ["settings", "get"],
    ["attachments", "persistGeneratedImageFromPath"],
    ["catalog", "currentSkills"],
    ["catalog", "currentPrompts"],
    ["catalog", "refreshCustomPrompts"],
    ["catalog", "shutdown"],
  ] as const;
  for (const [portName, methodName] of methods) {
    const port = ports[portName];
    if (typeof (port as unknown as Record<string, unknown>)[methodName] !== "function") {
      throw new TypeError(`Codex Provider port ${portName}.${methodName} is required`);
    }
  }
}
