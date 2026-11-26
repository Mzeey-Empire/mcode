import type {
  CodexProviderBoundary,
  ClaudeProviderBoundary,
  CursorProviderBoundary,
  DevinProviderBoundary,
  OpenCodeProviderBoundary,
  ProviderFactoryInput,
  CopilotProviderBoundary,
} from "./factory-types.js";
import { createProviderBoundary } from "./private/factory.js";
import { OPENCODE_SUPPORTED_CAPABILITIES, OpenCodeProvider } from "./private/opencode/opencode-provider.js";
import { createCursorAcpProvider, createDevinAcpProvider } from "./private/protocols/acp.js";
import { CodexProvider } from "./private/codex/codex-provider.js";
import { ClaudeProvider } from "./private/claude/claude-provider.js";
import { CopilotProvider } from "./private/copilot/copilot-provider.js";

/** Prepares the Claude Provider boundary without inspecting or spawning its CLI. */
export function createClaudeProvider(input: ProviderFactoryInput): ClaudeProviderBoundary {
  createProviderBoundary("claude", [], input);
  for (const method of ["isConfigured", "issue", "refresh", "release", "revokeCredential"] as const) {
    if (typeof input.host.browser[method] !== "function") throw new TypeError(`Claude browser ${method} port is required`);
  }
  if (typeof input.claude?.skills?.list !== "function") {
    throw new TypeError("Claude Provider port skills.list is required");
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
export function createCopilotProvider(input: ProviderFactoryInput): CopilotProviderBoundary {
  createProviderBoundary("copilot", [], input);
  if (typeof input.copilot?.launch?.resolve !== "function") {
    throw new TypeError("Copilot Provider port launch.resolve is required");
  }
  return new CopilotProvider(input.host, input.copilot, input.configuration.idleSessionTtlMs);
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
export function createOpenCodeProvider(input: ProviderFactoryInput): OpenCodeProviderBoundary {
  createProviderBoundary("opencode", OPENCODE_SUPPORTED_CAPABILITIES, input);
  if (typeof input.opencode?.settings?.get !== "function") {
    throw new TypeError("OpenCode Provider port settings.get is required");
  }
  if (typeof input.opencode.processScope?.create !== "function") {
    throw new TypeError("OpenCode Provider port processScope.create is required");
  }
  return new OpenCodeProvider(input.host, input.opencode);
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
