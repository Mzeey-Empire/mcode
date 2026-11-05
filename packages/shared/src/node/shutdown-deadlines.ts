/** Allows the PTY host to finish graceful termination and verify empty scopes. */
export const PTY_HOST_SHUTDOWN_DEADLINE_MS = 25_000;

/**
 * How long shutdown lets providers stop and report their own turn ends. Turns still running after it are
 * saved Interrupted, so a hung provider cannot spend the time the PTY host and the final saves need.
 */
export const AGENT_SHUTDOWN_GRACE_MS = 5_000;

/** Bounds the Interrupted saves made when the grace period ends. */
export const AGENT_SHUTDOWN_SAVE_MS = 2_000;

/** Agent stop runs before the PTY host, so its whole budget comes out of the server watchdog. */
export const AGENT_SHUTDOWN_DEADLINE_MS = AGENT_SHUTDOWN_GRACE_MS + AGENT_SHUTDOWN_SAVE_MS;

/** Left for provider teardown, persistence drain, and cleanup after agent stop and the PTY host. */
const SHUTDOWN_CLEANUP_RESERVE_MS = 3_000;

/** Includes agent stop, terminal shutdown, and the provider, persistence, and cleanup phases. */
export const SERVER_SHUTDOWN_DEADLINE_MS =
  AGENT_SHUTDOWN_DEADLINE_MS + PTY_HOST_SHUTDOWN_DEADLINE_MS + SHUTDOWN_CLEANUP_RESERVE_MS;

/** Lets the server watchdog finish before the desktop forces its owned process. */
export const DESKTOP_SHUTDOWN_DEADLINE_MS = SERVER_SHUTDOWN_DEADLINE_MS + 5_000;
