/**
 * Predicates for `/goal` slash-command routing on the composer side.
 *
 * Why the composer needs to know about goal semantics: when a goal is active
 * the agent's Stop hook blocks turn end until the goal is satisfied. If the
 * user then types `/goal clear`, the composer would normally enqueue the
 * message (because the agent is "running") and wait for `session.turnComplete`
 * to drain the queue — but turnComplete never fires while the goal blocks,
 * producing a deadlock where the user can never clear the goal they set.
 *
 * Control-form commands (`/goal`, `/goal clear`, `/goal reset`, `/goal show`)
 * are handled by the server's `AgentService` intercept synchronously without
 * any provider invocation. They are always safe to send directly — even
 * mid-turn — because clearing the goal frees the next Stop event to return
 * cleanly and ends the live turn naturally right after.
 */

/**
 * Returns `true` when `text` is a `/goal` control-form command that the
 * server intercept will short-circuit without dispatching to the agent.
 * Matches the `isControl` rule in `agent-service.ts` (case-insensitive
 * argument, leading/trailing whitespace tolerated).
 *
 * Returns `false` for the SET form (`/goal <condition>`) — those still need
 * the normal send path so the directive reaches the provider.
 */
export function isGoalControlCommand(text: string): boolean {
  const match = /^\s*\/goal\b\s*([\s\S]*)$/.exec(text);
  if (!match) return false;
  const arg = match[1].trim().toLowerCase();
  return arg === "" || arg === "clear" || arg === "reset" || arg === "show";
}
