import type { ProviderEventSinkPort } from "../../host-ports.js";
import {
  CanonicalLiveEventPublisher,
  type CanonicalLiveEventRouting,
} from "../canonical-live-event-publisher.js";

/** Identifies the canonical turn execution that owns Claude live events. */
export type ClaudeCanonicalEventRouting = CanonicalLiveEventRouting;

/** Serializes Claude live events through the provider-neutral canonical publisher. */
export class ClaudeCanonicalEventPublisher extends CanonicalLiveEventPublisher {
  constructor(sink: ProviderEventSinkPort, onFailure?: (routing: ClaudeCanonicalEventRouting, error: Error) => void) {
    super("claude", sink, onFailure);
  }
}
