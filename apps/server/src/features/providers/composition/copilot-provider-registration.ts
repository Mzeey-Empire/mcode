import { createCopilotProvider, type CopilotProviderBoundary, type ProviderFactoryInput } from "@mcode/providers";

/** Registers the exact usable Copilot factory instance with the server registry. */
export function registerCopilotProvider(registry: { registerInstance(token: "IAgentProvider", provider: CopilotProviderBoundary): unknown }, input: ProviderFactoryInput): CopilotProviderBoundary {
  const provider = createCopilotProvider(input);
  registry.registerInstance("IAgentProvider", provider);
  return provider;
}
