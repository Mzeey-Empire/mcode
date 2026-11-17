import type { OrchestrationMode } from "@mcode/contracts/models/enums";

/** Flag settings Mcode owns rather than inheriting from Claude settings files. */
export interface ClaudeFlagSettings {
  readonly ultracode: boolean;
}

/** Constructs the same explicit flags for spawn and session reuse. */
export function claudeFlagSettings(params: { orchestrationMode?: OrchestrationMode }): ClaudeFlagSettings {
  return { ultracode: params.orchestrationMode === "proactive" };
}

/** Returns only changed flags, or undefined when no SDK update is needed. */
export function changedFlagSettings(current: ClaudeFlagSettings, next: ClaudeFlagSettings): Partial<ClaudeFlagSettings> | undefined {
  return current.ultracode === next.ultracode ? undefined : { ultracode: next.ultracode };
}
