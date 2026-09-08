/** Allows the PTY host to finish graceful termination and verify empty scopes. */
export const PTY_HOST_SHUTDOWN_DEADLINE_MS = 25_000;

/** Includes terminal shutdown plus provider, persistence, and cleanup phases. */
export const SERVER_SHUTDOWN_DEADLINE_MS = PTY_HOST_SHUTDOWN_DEADLINE_MS + 10_000;

/** Lets the server watchdog finish before the desktop forces its owned process. */
export const DESKTOP_SHUTDOWN_DEADLINE_MS = SERVER_SHUTDOWN_DEADLINE_MS + 5_000;
