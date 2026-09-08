import { z } from "zod";
import { CODEX_STATIC_MODELS, type ProviderModelInfo } from "@mcode/contracts";
import type { CodexRpcClient } from "./codex-rpc-client.js";

const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modelPage = z.object({
  data: z.array(z.object({
    model: z.string().min(1).max(256),
    displayName: z.string().max(512),
    hidden: z.boolean(),
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().max(32) })).max(32),
    defaultReasoningEffort: z.string().max(32),
    inputModalities: z.array(z.string().max(32)).max(16),
  })).max(100),
  nextCursor: z.string().max(4096).nullable(),
});

function modelLabel(name: string, id: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim() || id;
  if (!/^[a-z0-9._-]+$/i.test(clean)) return clean;
  const words = clean.replace(/^gpt[-_]/i, "GPT ").replace(/[-_]/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  return words.replace(/^GPT /, "GPT-");
}

function providerModel(model: z.infer<typeof modelPage>["data"][number]): ProviderModelInfo {
  const supportedReasoningEfforts = model.supportedReasoningEfforts.flatMap((option) => {
    const parsed = effort.safeParse(option.reasoningEffort);
    return parsed.success ? [parsed.data] : [];
  });
  const defaultEffort = effort.safeParse(model.defaultReasoningEffort);
  const known = CODEX_STATIC_MODELS.find((entry) => entry.id === model.model);
  return {
    id: model.model,
    name: modelLabel(model.displayName, model.model),
    group: "OpenAI",
    ...(known?.contextWindow ? { contextWindow: known.contextWindow } : {}),
    supportsVision: model.inputModalities.includes("image"),
    supportsReasoning: supportedReasoningEfforts.length > 0,
    supportedReasoningEfforts,
    ...(defaultEffort.success ? { defaultReasoningEffort: defaultEffort.data } : {}),
  };
}

/** Reads visible Codex models in provider order without starting a thread or turn. */
export async function listCodexModels(rpc: Pick<CodexRpcClient, "sendRequest">): Promise<ProviderModelInfo[]> {
  const models: ProviderModelInfo[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = modelPage.parse(await rpc.sendRequest("model/list", {
      limit: 100,
      includeHidden: false,
      ...(cursor === null ? {} : { cursor }),
    }, 10_000));
    models.push(...page.data.filter((model) => !model.hidden).map(providerModel));
    cursor = page.nextCursor;
    if (cursor === null) return models;
    if (cursors.has(cursor)) throw new Error("Codex model catalog repeated a pagination cursor");
    cursors.add(cursor);
  }
  throw new Error("Codex model catalog exceeded the pagination limit");
}
