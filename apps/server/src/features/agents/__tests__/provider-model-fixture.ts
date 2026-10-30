import type { ProviderModelInfo } from "@mcode/contracts/providers/models";

/** Ordered provider fixture models with no Fast support. */
export const testModelCatalog = {
  listModels: async (): Promise<ProviderModelInfo[]> => [
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "gpt-5.5", name: "GPT-5.5" },
  ],
};
