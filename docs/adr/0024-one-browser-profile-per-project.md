# 0024: One browser profile per project

Status: Accepted

Date: 2026-10-10

## Context

A shared Browser cookie jar lets one project's logins affect another project.
Clearing cookies or cache must act on the project shown in the window, including
when several windows have Browser guests open.

## Decision

Use one persistent Electron partition per workspace UUID. Preparation binds the
workspace, partition and adoption token. Attachment requires that exact partition;
adoption requires the exact workspace session. Install clipboard trust, download
denial and failed-request recording before returning a session to attachment.

Remove profiles on the server's workspace-deleted push and reconcile them after
each successful complete workspace list. Release guests in every window before
clearing storage and cache. Delete history and thumbnails under
`userData/browser-profiles/<uuid>` at removal.

Electron 35.7.5's [browser context implementation](https://github.com/electron/electron/blob/v35.7.5/shell/browser/electron_browser_context.cc#L355-L362)
places persistent partitions under `sessionData/Partitions`, lowercasing and
escaping the partition name. UUID names therefore produce
`Partitions/mcode-browser-<uuid>`. Use `sessionData` rather than assuming it always
equals `userData`. Opened sessions remain in Electron until exit, so remove their
directory during a later launch's reconciliation, before creating a session for it.

Clear the old shared jar by deleting its unopened partition directory before any
Browser session starts. Write a migration marker in `userData` only after deletion
succeeds. Do not copy cookies into the new profiles.

## Consequences

Users sign in again for each project. Storage grows with the project count.
Removal clears opened profiles immediately; their empty Chromium directories can
remain until the next launch. A failed workspace list never triggers reconciliation.
The web runtime has no desktop profile data to remove.
