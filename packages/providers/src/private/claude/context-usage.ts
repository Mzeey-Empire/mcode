import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "@mcode/shared";
import { z } from "zod";

/** Claude Code's resolved compaction window and its current occupancy. */
export interface ClaudeContextUsage {
  readonly windowTokens: number;
  readonly usedTokens: number;
}

const contextUsageSchema = z.object({
  rawMaxTokens: z.number().int().positive(),
  totalTokens: z.number().finite().nonnegative(),
});
const reportedFailures = new Set<string>();

/** Validates a context control response at the SDK boundary. */
export function parseClaudeContextUsage(raw: unknown): ClaudeContextUsage | undefined {
  const parsed = contextUsageSchema.safeParse(raw);
  return parsed.success
    ? { windowTokens: parsed.data.rawMaxTokens, usedTokens: parsed.data.totalTokens }
    : undefined;
}

/** Reads the user's resolved window without interrupting a turn on older CLIs. */
export async function readClaudeContextUsage(query: Pick<Query, "getContextUsage">): Promise<ClaudeContextUsage | undefined> {
  try {
    const usage = parseClaudeContextUsage(await query.getContextUsage({ detail: "summary" }));
    if (!usage) reportFailure("invalid response");
    return usage;
  } catch (error) {
    reportFailure(error instanceof Error ? error.message : "unknown failure");
    return undefined;
  }
}

function reportFailure(reason: string): void {
  if (reportedFailures.has(reason)) return;
  reportedFailures.add(reason);
  logger.warn("Claude context usage unavailable", { reason });
}
