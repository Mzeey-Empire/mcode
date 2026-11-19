import type { PickerProviderScope } from "@/components/chat/ModelPickerPanel";

/** The composer facts that decide which providers its model picker offers. */
export interface PickerProviderScopeInput {
  /** The thread exists and has run, so it is neither a new thread nor a branch-from-message draft. */
  readonly started: boolean;
  readonly threadProviderId: string | null | undefined;
  readonly isAgentRunning: boolean;
}

/** Derives the composer model picker's provider scope from the thread's state. */
export function pickerProviderScopeOf({ started, threadProviderId }: PickerProviderScopeInput): PickerProviderScope {
  if (!started || !threadProviderId) return { kind: "all" };
  return { kind: "selected-only" };
}
