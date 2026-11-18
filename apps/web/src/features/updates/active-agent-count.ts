import { getTransport } from "@/transport";

/** How long an install waits for the server's running-agent count before treating it as unknown. */
export const AGENT_COUNT_DEADLINE_MS = 3_000;

/**
 * Asks the server how many agents run across every window, or null when the count is unreadable or late.
 * Callers treat null as "agents may be running" so an install never silently stops work.
 */
export async function readActiveAgentCount(): Promise<number | null> {
  // The shared transport waits for its socket with no deadline, so the cap lives here.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(null), AGENT_COUNT_DEADLINE_MS);
  });
  try {
    return await Promise.race([getTransport().getActiveAgentCount(), deadline]);
  } catch {
    return null;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
