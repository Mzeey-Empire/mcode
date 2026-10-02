import * as NodeUtil from "node:util";
import type { AgentEvent } from "@mcode/contracts";
import type { CodexLiveWriterIntent } from "../execution/codex-live-event-reducer.js";

/** System intents prepared by the execution reducer for admission and storage validation. */
export type CodexSystemWriterIntent = Extract<CodexLiveWriterIntent,
  { kind: "notice-session" | "system-notice" | "session-cursor" }>;

type SystemEvent = Extract<AgentEvent, { type: "system" }>;

/** Require the same event and exact projection intent before admission or persistence. */
export function matchesCodexSystemIntents(event: SystemEvent, intents: readonly CodexSystemWriterIntent[]): boolean {
  const expected = expectedSystemIntentKind(event);
  if (!Array.isArray(intents) || intents.length !== (expected ? 1 : 0)) return false;
  if (!expected) return true;
  return intents[0]?.kind === expected && NodeUtil.isDeepStrictEqual(intents[0].event, event)
    && (expected !== "system-notice" || !event.messageId);
}

function expectedSystemIntentKind(event: SystemEvent): CodexSystemWriterIntent["kind"] | null {
  if (event.subtype === "provider.session.started") return "notice-session";
  if (event.subtype.startsWith("provider.notice.") && event.message) return "system-notice";
  if (event.subtype.startsWith("sdk_session_id:") || event.subtype === "sdk_session_invalidated") return "session-cursor";
  return null;
}
