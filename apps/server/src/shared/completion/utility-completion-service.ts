import { injectable, inject } from "tsyringe";
import { logger } from "@mcode/shared";
import { isCompletionCapable } from "@mcode/contracts/providers/interfaces";
import type { CompletionOptions, IProviderRegistry, ProviderId } from "@mcode/contracts/providers/interfaces";
import type { ReasoningLevel } from "@mcode/contracts/models/settings";
import { SettingsService } from "../../features/settings/settings-service.js";
import { ProviderAvailabilityService } from "../../features/providers/availability/provider-availability-service.js";

interface UtilityModelDefault {
  readonly id: string;
  /** Used when the caller sets no level, so a short task never waits on the model's own default effort. */
  readonly reasoningLevel?: ReasoningLevel;
}

const CLAUDE_UTILITY_DEFAULT: UtilityModelDefault = { id: "claude-haiku-5-5", reasoningLevel: "low" };

/** Per-provider default models for utility tasks, used when the settings name no utility model. */
const UTILITY_MODEL_DEFAULTS: Record<string, UtilityModelDefault> = {
  claude: CLAUDE_UTILITY_DEFAULT,
  copilot: { id: "gpt-4.1-mini" },
};

/** Neither the configured utility provider nor the Claude fallback can run completions. */
export class NoCompletionProviderError extends Error {
  constructor() {
    super("No completion-capable provider available for utility tasks");
    this.name = "NoCompletionProviderError";
  }
}

/** One finished utility completion and the provider and model that produced it. */
export interface UtilityCompletion {
  text: string;
  provider: ProviderId;
  model: string;
}

/**
 * Middleware that resolves the configured utility provider+model
 * and exposes a single `complete()` method for all lightweight AI tasks.
 */
@injectable()
export class UtilityCompletionService {
  constructor(
    @inject(SettingsService)
    private readonly settingsService: SettingsService,
    @inject("IProviderRegistry")
    private readonly providerRegistry: IProviderRegistry,
    @inject(ProviderAvailabilityService)
    private readonly availability: ProviderAvailabilityService,
  ) {}

  /**
   * Run a one-shot completion using the configured utility model.
   * Returns the generated text and the provider and model ID that produced it.
   */
  async complete(prompt: string, cwd: string, options: CompletionOptions = {}): Promise<UtilityCompletion> {
    const settings = this.settingsService.get();
    const { provider: resolvedProvider, model: resolvedModel } =
      this.resolveProviderAndModel(settings);

    let provider = resolvedProvider;
    let model = resolvedModel;
    await this.availability.assertUsable(provider);

    let agent = this.providerRegistry.resolve(provider);

    if (!isCompletionCapable(agent)) {
      logger.warn(
        `Utility provider "${provider}" does not support completion, falling back to claude`,
      );
      provider = "claude" as ProviderId;
      model = "";
      await this.availability.assertUsable(provider);
      agent = this.providerRegistry.resolve(provider);

      if (!isCompletionCapable(agent)) {
        throw new NoCompletionProviderError();
      }
    }

    if (model) {
      const text = await agent.complete(prompt, model, cwd, options);
      return { text, provider, model };
    }
    const fallback = UTILITY_MODEL_DEFAULTS[provider] ?? CLAUDE_UTILITY_DEFAULT;
    model = fallback.id;
    const reasoningLevel = options.reasoningLevel ?? fallback.reasoningLevel;
    const text = await agent.complete(prompt, model, cwd, reasoningLevel === undefined ? options : { ...options, reasoningLevel });
    return { text, provider, model };
  }

  private resolveProviderAndModel(settings: {
    model: {
      defaults: { provider: string };
      utility: { provider: string; id: string };
    };
  }): { provider: ProviderId; model: string } {
    const utilityProvider = settings.model.utility.provider;
    const defaultsProvider = settings.model.defaults.provider;

    const provider = (utilityProvider || defaultsProvider || "claude") as ProviderId;
    const model = settings.model.utility.id;

    return { provider, model };
  }
}
