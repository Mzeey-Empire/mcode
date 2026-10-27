import type { AgentEvent } from "@mcode/contracts/events/agent-event";
import type { ProviderId } from "@mcode/contracts/providers/interfaces";

import type { CodexChildRoutingDiagnosticInput } from "../../agents/collaboration/codex-collaboration-durability.js";
import type { ProviderEventIngressEvent } from "./provider-event-ingress.js";

/** Injection token for the optional Codex-specific provider event adapter. */
export const CODEX_PROVIDER_EVENT_ADAPTER = Symbol("CodexProviderEventAdapter");

/** The normalized outcome of one provider-specific event interpretation. */
export type ProviderEventProjection =
  | { status: "forward"; event: AgentEvent }
  | { status: "consumed" }
  | { status: "rejected"; diagnostic: CodexChildRoutingDiagnosticInput };

/** Translates one provider-native event contract before generic turn processing. */
export interface ProviderEventAdapter {
  readonly providerId: ProviderId;
  project(event: ProviderEventIngressEvent): ProviderEventProjection;
}
