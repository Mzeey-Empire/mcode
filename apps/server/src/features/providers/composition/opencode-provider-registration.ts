import { createOpenCodeProvider, type OpenCodeProviderBoundary, type ProviderFactoryInput } from "@mcode/providers";

/** Registers the exact usable OpenCode factory instance as the server Provider. */
export function registerOpenCodeProvider(
  registry: { registerInstance(token: "IAgentProvider", provider: OpenCodeProviderBoundary): unknown },
  input: ProviderFactoryInput,
): OpenCodeProviderBoundary {
  const provider = createOpenCodeProvider(input);
  registry.registerInstance("IAgentProvider", provider);
  return provider;
}
