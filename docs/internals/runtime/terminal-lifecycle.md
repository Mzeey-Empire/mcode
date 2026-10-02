# Terminal ownership and recovery

Terminal view retention preserves access to a running shell. It does not make
the shell recoverable after its server or PTY host fails. This distinction
matters when reconnecting transport or replacing a renderer appears to work
like restarting the terminal runtime.

## Runtime ownership

The Bun server owns shell-session records and bounded output retention. Both
terminal backends use the same separate Node PTY host to own native PTYs and
contained shell process trees. The [backend composition](../../../apps/server/src/features/terminal/composition/register-terminal.ts)
connects the legacy service and modern runtime to that host.

The [backend selector](../../../apps/server/src/features/terminal/backends/terminal-backend-selector.ts)
defaults to `legacy`. `MCODE_TERMINAL_BACKEND=modern` opts into `modern` before
the server accepts requests. The choice is immutable for that server boot.
The modern attachment rules below do not describe the legacy protocol.

## View changes and transport reconnects

[ADR 0010](../../adr/0010-terminal-view-detach-shell-session-persists.md)
separates the disposable terminal view from the running shell session. Each
renderer keeps at most one terminal view mounted. Hiding the selected Terminal
tab or panel keeps that view warm while the server retains output.
Switching shells or scopes replaces the view without closing either shell.

A returning view receives retained output, using a delta or bounded hydration.
Replay can include a checkpoint and later output. Retention limits can discard
older history, so replay does not promise the shell's complete output history.
The [legacy reattach path](../../../apps/server/src/features/terminal/backends/legacy/terminal-service.ts)
and [modern attachment runtime](../../../apps/server/src/features/terminal/sessions/terminal-session-runtime.ts)
implement these distinct replay protocols.

A transport disconnect can be repaired while the server, PTY host, and shell
remain alive. The [WebSocket reconnect path](../../../apps/web/src/transport/ws-transport.ts)
lists existing sessions and reattaches the selected running shell. It does not
create a replacement shell or resume a terminated one.

## Modern attachment and input ownership

An attachment is the modern backend's current controller lease for a shell.
Attaching allocates a new attachment epoch and revokes the prior controller.
Detaching releases that lease and leaves the shell running.

The [modern runtime](../../../apps/server/src/features/terminal/sessions/terminal-session-runtime.ts)
accepts input and resize commands only for the shell's host generation and
current attachment epoch, after hydration completes. Each command must have
the next command sequence. A stale controller cannot write to a replacement
attachment, and a view cannot send input before its retained output is ready.

Unacknowledged input makes reconnect different from a safe retry. Detaching
or replacing an attachment with pending input marks delivery as unknown.
An input acknowledgement timeout also revokes the attachment. The runtime
reports `INPUT_DELIVERY_UNKNOWN` and blocks further input until the outstanding
input is acknowledged. Resending those bytes could execute a shell command
twice, so an attachment change must not imply that the input failed to arrive.

## Shell, server, and host failure

Closing a Terminal tab closes its shell process tree, as recorded in
[ADR 0020](../../adr/0020-repeatable-terminal-tabs-in-right-panel-order.md).
A shell that exits has no running process to reconnect to. The modern runtime
can retain an exited session for bounded output hydration, but that record
does not keep the shell alive.

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
