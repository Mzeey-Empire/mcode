import { createClaudeProvider, type ClaudeProviderBoundary, type ProviderFactoryInput } from "@mcode/providers";

/** Registers the single usable Claude factory instance under both server tokens. */
export function registerClaudeProvider(
  registry: { registerInstance(token: "IAgentProvider" | "ClaudeProvider", provider: ClaudeProviderBoundary): unknown },
  input: ProviderFactoryInput,
): ClaudeProviderBoundary {
  const provider = createClaudeProvider(input);
  registry.registerInstance("IAgentProvider", provider);
  registry.registerInstance("ClaudeProvider", provider);
  return provider;
}
