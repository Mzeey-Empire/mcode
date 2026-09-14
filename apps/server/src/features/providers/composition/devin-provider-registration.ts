import { createDevinProvider, type DevinProviderBoundary, type ProviderFactoryInput } from "@mcode/providers";

/** Registers the exact usable Devin factory instance as the server Provider. */
export function registerDevinProvider(
  registry: { registerInstance(token: "IAgentProvider", provider: DevinProviderBoundary): unknown },
  input: ProviderFactoryInput,
): DevinProviderBoundary {
  const provider = createDevinProvider(input);
  registry.registerInstance("IAgentProvider", provider);
  return provider;
}
