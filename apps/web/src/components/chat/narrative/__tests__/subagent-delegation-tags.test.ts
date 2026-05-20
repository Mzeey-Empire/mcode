import { describe, expect, it } from "vitest";
import { buildDelegationTags } from "../subagent-delegation-tags";
import type { ToolCall } from "@/transport/types";

function mkAgent(partial: Partial<ToolCall>): ToolCall {
  return {
    id: "agent-1",
    toolName: "Agent",
    toolInput: {},
    output: null,
    isError: false,
    isComplete: false,
    startedAt: 0,
    parentToolCallId: null,
    ...partial,
  };
}

describe("buildDelegationTags", () => {
  it("includes Task and formatted model from cursor/task toolInput", () => {
    const tags = buildDelegationTags(
      mkAgent({
        toolInput: {
          description: "Glob files",
          model: "composer-2.5-fast",
          subagentType: { custom: { unspecified: {} } },
        },
      }),
    );
    expect(tags).toContain("Task");
    expect(tags).toContain("Composer");
  });

  it("appends duration from tool result output when complete", () => {
    const tags = buildDelegationTags(
      mkAgent({
        isComplete: true,
        output: "Glob files\nCompleted in 8.3s\nModel: composer-2.5-fast",
        toolInput: { model: "composer-2.5-fast" },
      }),
    );
    expect(tags).toContain("8.3s");
  });
});
