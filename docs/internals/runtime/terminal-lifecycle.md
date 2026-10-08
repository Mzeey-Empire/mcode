# Terminal ownership and recovery

Terminal view retention preserves access to a running shell. It does not make
the shell recoverable after its server or PTY host fails. This distinction
matters when reconnecting transport or replacing a renderer appears to work
like restarting the terminal runtime.

## Runtime ownership

The Bun server owns shell-session records and bounded output retention. The
[legacy service](../../../apps/server/src/features/terminal/backends/legacy/terminal-service.ts)
uses a separate Node PTY host to own native PTYs and contained shell process
trees, wired through the [backend composition](../../../apps/server/src/features/terminal/composition/register-terminal.ts).

## View changes and transport reconnects

[ADR 0010](../../adr/0010-terminal-view-detach-shell-session-persists.md)
separates the disposable terminal view from the running shell session. Each
renderer keeps at most one terminal view mounted. Hiding the selected Terminal
tab or panel keeps that view warm while the server retains output.
Switching shells or scopes replaces the view without closing either shell.

A returning view receives retained output, using a delta or bounded hydration.
Replay can include a checkpoint and later output. Retention limits can discard
older history, so replay does not promise the shell's complete output history.
The [reattach path](../../../apps/server/src/features/terminal/backends/legacy/terminal-service.ts)
replays both running and exited records.

A transport disconnect can be repaired while the server, PTY host, and shell
remain alive. The [WebSocket reconnect path](../../../apps/web/src/transport/ws-transport.ts)
lists retained records and reattaches the selected terminal. It does not
create a replacement shell or resume a terminated one.

## Shell, server, and host failure

Closing a Terminal tab closes its shell process tree, as recorded in
[ADR 0020](../../adr/0020-repeatable-terminal-tabs-in-right-panel-order.md).
A shell that exits keeps its terminal record, bounded replay output, and exit
code until the user closes it or its scope is deleted. Exited records count
toward the eight-terminal scope limit. Switching scopes or reloading the client
restores the record and its output; Retry replaces it with a new shell.

Server loss discards the in-memory session and replay owners. Cleanup records
identify process trees to reap when the next host starts. They are not saved
shell sessions and do not restore the old processes or output history.

The [PTY host supervisor](../../../apps/server/src/features/terminal/host/pty-host-supervisor.ts)
records the shell's root PID and containment information before acknowledging
creation. If that record cannot be saved, creation does not succeed.
This ordering gives cleanup an owner even if failure follows the acknowledgement.

Host failure ends sessions belonging to the failed host generation. The
supervisor waits for pending host events, reaps that generation's recorded
process trees, then permits one automatic replacement attempt. Failed cleanup
prevents replacement. A healthy replacement restores capacity to create new
shells, not the failed generation's shells.

## Packaged runtime boundary

The [desktop launcher](../../../apps/desktop/src/features/server-runtime/process/child.ts)
runs the server with Bun and supplies a separate Electron executable for the
Node PTY host. Native `node-pty` support belongs in that host process.
The executable's packaged name, `mcode-server`, does not mean it runs the Bun
application server.

[Packaging](../../../apps/desktop/scripts/desktop-packaging/target-package/after-pack.mjs)
copies the Electron executable before applying GUI snapshot and fuse changes.
The PTY copy runs with `ELECTRON_RUN_AS_NODE=1`. Enabling the GUI's V8 snapshot
fuse on that copy makes it require a snapshot that is not staged beside it.
Windows also needs ConPTY's companion runtime files.
Keeping `conpty.node` alone is insufficient, so packaging restores those files
and retains the target's terminal native artifacts.
