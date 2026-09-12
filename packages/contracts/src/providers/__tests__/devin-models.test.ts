import { describe, expect, it } from "vitest";
import {
  DEVIN_STATIC_MODEL_FALLBACK,
  groupDevinModelFamilies,
  resolveDevinModelId,
  type DevinModelFamily,
} from "../devin-models.js";
import type { ProviderModelInfo } from "../models.js";

const LIVE_SAMPLE: ProviderModelInfo[] = [
  { id: "swe-2-medium", name: "SWE-2 Medium", group: "Cognition" },
  { id: "swe-2-high", name: "SWE-2 High", group: "Cognition" },
  { id: "swe-2-max", name: "SWE-2 Max", group: "Cognition" },
  { id: "swe-1-7", name: "SWE-1.7", group: "Cognition" },
  { id: "swe-1-7-medium", name: "SWE-1.7 Medium", group: "Cognition" },
  { id: "gpt-5-6-sol-low", name: "GPT-5.6 Sol Low Thinking", group: "OpenAI" },
  { id: "gpt-5-6-sol-high-priority", name: "GPT-5.6 Sol High Thinking Fast", group: "OpenAI" },
  { id: "gpt-5-6-sol-max-priority", name: "GPT-5.6 Sol Max Thinking Fast", group: "OpenAI" },
  { id: "glm-5-2", name: "GLM-5.2 High", group: "Zhipu" },
  { id: "glm-5-2-none", name: "GLM-5.2 No Thinking", group: "Zhipu" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Anthropic" },
  { id: "MODEL_GPT_5_2_HIGH", name: "GPT-5.2 High Thinking", group: "Other" },
  { id: "fusion-claude-opus-5-high-sidekick-swe-2-high", name: "Fusion (Claude Opus 5 High + SWE-2 High)", group: "Other" },
];

function family(families: readonly DevinModelFamily[], id: string): DevinModelFamily {
  const found = families.find((entry) => entry.id === id);
  if (!found) throw new Error(`family ${id} not found`);
  return found;
}

describe("groupDevinModelFamilies", () => {
  it("collapses effort-suffixed ids into one family row", () => {
    const { models, families } = groupDevinModelFamilies(LIVE_SAMPLE);
    const swe2 = family(families, "swe-2");

    expect(swe2.supportedReasoningEfforts).toEqual(["medium", "high", "max"]);
    expect(swe2.defaultReasoningEffort).toBe("high");
    expect(swe2.name).toBe("SWE-2");
    expect(models.filter((m) => m.id === "swe-2")).toHaveLength(1);
    expect(models.some((m) => m.id === "swe-2-high")).toBe(false);
  });

  it("merges a bare member into its family as the default row", () => {
    const { models, families } = groupDevinModelFamilies(LIVE_SAMPLE);
    const swe17 = family(families, "swe-1-7");

    expect(swe17.bareModelId).toBe("swe-1-7");
    expect(swe17.supportedReasoningEfforts).toEqual(["medium"]);
    expect(models.filter((m) => m.id === "swe-1-7")).toHaveLength(1);
  });

  it("keeps variant tails in the family id", () => {
    const { families } = groupDevinModelFamilies(LIVE_SAMPLE);
    const fast = family(families, "gpt-5-6-sol-priority");

    expect(fast.supportedReasoningEfforts).toEqual(["high", "max"]);
    expect(fast.effortModelIds.max).toBe("gpt-5-6-sol-max-priority");
    expect(fast.name).toBe("GPT-5.6 Sol Fast");
  });

  it("maps a bare row's name-implied effort back to the bare id", () => {
    const { models, families } = groupDevinModelFamilies(LIVE_SAMPLE);
    const glm = family(families, "glm-5-2");

    expect(glm.supportedReasoningEfforts).toEqual(["none", "high"]);
    expect(glm.effortModelIds.high).toBe("glm-5-2");
    expect(glm.defaultReasoningEffort).toBe("high");
    expect(glm.name).toBe("GLM-5.2");
    expect(resolveDevinModelId(families, "glm-5-2", "high")).toBe("glm-5-2");
    expect(resolveDevinModelId(families, "glm-5-2", "none")).toBe("glm-5-2-none");
    expect(models.filter((m) => m.id === "glm-5-2")).toHaveLength(1);
  });

  it("lists Cognition-grouped models before other vendor groups", () => {
    const sample: ProviderModelInfo[] = [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", group: "Anthropic" },
      { id: "swe-2-high", name: "SWE-2 High", group: "Cognition" },
      { id: "swe-2-max", name: "SWE-2 Max", group: "Cognition" },
    ];
    const { models } = groupDevinModelFamilies(sample);

    expect(models.map((model) => model.id)).toEqual(["swe-2", "claude-sonnet-4-6"]);
  });

  it("passes through ids without an effort pattern, legacy enums, and fusion rows", () => {
    const { models } = groupDevinModelFamilies(LIVE_SAMPLE);
    const ids = models.map((m) => m.id);

    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("MODEL_GPT_5_2_HIGH");
    expect(ids).toContain("fusion-claude-opus-5-high-sidekick-swe-2-high");
  });
});

describe("resolveDevinModelId", () => {
  const { families } = groupDevinModelFamilies(LIVE_SAMPLE);

  it("composes family + effort into the concrete catalog id", () => {
    expect(resolveDevinModelId(families, "swe-2", "medium")).toBe("swe-2-medium");
    expect(resolveDevinModelId(families, "gpt-5-6-sol-priority", "max")).toBe("gpt-5-6-sol-max-priority");
  });

  it("uses the default effort for a bare family selection", () => {
    expect(resolveDevinModelId(families, "swe-2", undefined)).toBe("swe-2-high");
  });

  it("keeps an explicit bare variant when no effort is set", () => {
    expect(resolveDevinModelId(families, "swe-1-7", undefined)).toBe("swe-1-7");
  });

  it("remaps a concrete member id when the effort changes", () => {
    expect(resolveDevinModelId(families, "swe-2-high", "max")).toBe("swe-2-max");
  });

  it("returns unknown ids untouched", () => {
    expect(resolveDevinModelId(families, "claude-sonnet-4-6", "high")).toBe("claude-sonnet-4-6");
  });
});

describe("DEVIN_STATIC_MODEL_FALLBACK", () => {
  it("groups into the swe-2 and swe-1-7 families", () => {
    const { families } = groupDevinModelFamilies(DEVIN_STATIC_MODEL_FALLBACK);

    expect(family(families, "swe-2").supportedReasoningEfforts).toEqual(["medium", "high", "max"]);
    expect(family(families, "swe-1-7").bareModelId).toBe("swe-1-7");
  });
});
