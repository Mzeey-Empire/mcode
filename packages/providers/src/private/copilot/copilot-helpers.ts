import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { QuotaCategory } from "@mcode/contracts";
import type { ProviderThreadControlHttpConnection } from "../../host-ports.js";
/** Builds the Copilot SDK's remote HTTP MCP configuration for one provider session. */
export function buildCopilotInternalMcpServers(
  connection: ProviderThreadControlHttpConnection,
): Record<string, { type: "http"; url: string; headers: Record<string, string>; tools: ["*"] }> {
  return {
    [connection.name]: {
      type: "http",
      url: connection.url,
      headers: connection.headers,
      tools: ["*"],
    },
  };
}

/** Preserves existing Copilot user instructions while appending runtime guidance. */
export function composeCopilotSystemMessage(
  userInstructions: string | undefined,
  runtimeInstructions: string,
): { content: string } {
  return {
    content: [userInstructions, runtimeInstructions]
      .filter((value): value is string => Boolean(value && value.trim()))
      .join("\n\n"),
  };
}


/**
 * Reads user-level Copilot instructions from `~/.copilot/copilot-instructions.md`.
 * Returns `undefined` if the file does not exist or cannot be read.
 */
export function readUserInstructions(): string | undefined {
  try {
    return NodeFS.readFileSync(NodePath.join(NodeOS.homedir(), ".copilot", "copilot-instructions.md"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Returns user-level Copilot skill directories to pass to the SDK session.
 * Currently resolves `~/.copilot/skills` if it exists.
 */
export function userSkillDirectories(): string[] {
  const dir = NodePath.join(NodeOS.homedir(), ".copilot", "skills");
  return NodeFS.existsSync(dir) ? [dir] : [];
}

/** Maps raw Copilot quota snapshot keys to human-readable labels. */
const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium usage",
  chat: "Chat",
  completions: "Completions",
};

/** Shape of a single quota snapshot entry from the Copilot SDK assistant.usage event. */
interface QuotaSnapshot {
  isUnlimitedEntitlement?: boolean;
  entitlementRequests?: number;
  usedRequests?: number;
  remainingPercentage?: number;
  resetDate?: string;
  overage?: number;
  overageAllowedWithExhaustedQuota?: boolean;
  usageAllowedWithExhaustedQuota?: boolean;
}

/**
 * Converts a raw Copilot quota snapshot map into an array of normalized QuotaCategory objects
 * suitable for the QuotaUpdate AgentEvent.
 */
export function normalizeQuotaSnapshots(
  snapshots: Record<string, QuotaSnapshot>,
): QuotaCategory[] {
  return Object.entries(snapshots).map(([key, snap]) => {
    // A category is limited only when the API provides a positive entitlement value
    // and does not mark it as unlimited. Categories returned with no entitlement
    // data (entitlementRequests = 0 or absent) default to unlimited so we never
    // display a misleading 0/0.
    const hasLimit = (snap.entitlementRequests ?? 0) > 0;
    const isUnlimited = snap.isUnlimitedEntitlement ?? !hasLimit;
    return {
      label: QUOTA_LABELS[key] ?? key,
      used: snap.usedRequests ?? 0,
      total: hasLimit ? snap.entitlementRequests! : null,
      remainingPercent: (snap.remainingPercentage ?? 100) / 100,
      resetDate: snap.resetDate,
      isUnlimited,
    };
  });
}

/** Infer vendor group from model ID prefix for UI section headers. */
export function inferModelGroup(modelId: string): string | undefined {
  const group = MODEL_GROUPS.find(({ names }) => names.some((name) => modelId === name || modelId.startsWith(`${name}-`)));
  return group?.label;
}

const MODEL_GROUPS = [
  { label: "OpenAI", names: ["gpt", "o1", "o3", "o4"] },
  { label: "Anthropic", names: ["claude"] },
  { label: "Google", names: ["gemini"] },
  { label: "xAI", names: ["grok"] },
] as const;
