import type { OrchestrationMode } from "@mcode/contracts/models/enums";

/** Flag settings Mcode owns rather than inheriting from Claude settings files. */
export interface ClaudeFlagSettings {
  readonly ultracode: boolean;
  readonly fastMode: boolean;
}

/** Constructs the same explicit flags for spawn and session reuse. */
export function claudeFlagSettings(params: { orchestrationMode?: OrchestrationMode; fastMode?: boolean }): ClaudeFlagSettings {
  return { ultracode: params.orchestrationMode === "proactive", fastMode: params.fastMode === true };
}

/** Returns only changed flags, or undefined when no SDK update is needed. */
export function changedFlagSettings(current: ClaudeFlagSettings, next: ClaudeFlagSettings): Partial<ClaudeFlagSettings> | undefined {
  const changed: Partial<ClaudeFlagSettings> = {
    ...(current.ultracode !== next.ultracode ? { ultracode: next.ultracode } : {}),
    ...(current.fastMode !== next.fastMode ? { fastMode: next.fastMode } : {}),
  };
  return Object.keys(changed).length ? changed : undefined;
}
