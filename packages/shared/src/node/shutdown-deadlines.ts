/** Allows the PTY host to finish graceful termination and verify empty scopes. */
export const PTY_HOST_SHUTDOWN_DEADLINE_MS = 25_000;

/** Includes terminal shutdown plus provider, persistence, and cleanup phases. */
export const SERVER_SHUTDOWN_DEADLINE_MS = PTY_HOST_SHUTDOWN_DEADLINE_MS + 10_000;

/** The end of server shutdown kept for writing accepted turn output to SQLite and closing the databases. */
export const SHUTDOWN_PERSISTENCE_RESERVE_MS = 5_000;

/** The end of the persistence reserve kept for closing the databases after accepted saves stop retrying. */
export const SHUTDOWN_DATABASE_CLOSE_RESERVE_MS = 1_000;

/** When persistence starts at the latest, measured from shutdown start, however long other phases take. */
export const SHUTDOWN_PERSISTENCE_START_MS = SERVER_SHUTDOWN_DEADLINE_MS - SHUTDOWN_PERSISTENCE_RESERVE_MS;

/** Lets the server watchdog finish before the desktop forces its owned process. */
export const DESKTOP_SHUTDOWN_DEADLINE_MS = SERVER_SHUTDOWN_DEADLINE_MS + 5_000;
