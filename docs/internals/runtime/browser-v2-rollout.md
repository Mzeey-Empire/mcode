# Browser v2 operations

Browser v2 is the only Browser automation path. Every provider receives the
same scoped MCP gateway and the same current tool contract:

- `browser_open`
- `browser_inspect`
- `browser_act`
- `browser_tabs`
- `browser_evaluate` for privileged sessions only

Read `browserAutomation.nightlyEvidence` from `GET /health` for content-free
diagnostics. The report includes request counts, failure rates and classes,
zero-tolerance outcome counts, retained lifecycle events, and bounded recent
failure bundles. It does not include page content, credentials, headers,
screenshots, evaluation data, full URLs, or response bodies.

The Browser lifecycle log keeps one correlation ID from MCP routing through
cleanup. Browser v2 actions use the latest observation reference, a fresh
idempotency key, and typed recovery results. Navigation, reload, and back end
the current observation boundary. Inspect before another mutation.

## Host lifecycle invariant

Closing or finalizing an agent-controlled tab removes the target before the
Browser response is delivered. The renderer host keeps that request alive
until it reconciles the close and sends the final receipt. Target removal
cancels every operation that did not request the removal.

## Security boundaries

Every desktop Browser guest uses the persistent `persist:mcode-preview`
partition. Cookies and HTTP cache survive guest replacement and are shared
across threads and workspaces under Chromium's origin rules. Clearing cookies
or cache affects the shared partition, not one tab. The
[session policy](../../../apps/desktop/src/features/preview/security/electron-session-policy.ts)
owns that partition and its permission handlers.

Electron main [fixes each webview's attachment policy](../../../apps/desktop/src/features/preview/security/webview-attachment-policy.ts)
before creation. It disables Node integration, enables context isolation and
sandboxing, and replaces the preload and partition with Mcode's fixed values.
The [adoption registry](../../../apps/desktop/src/features/preview/surfaces/registry.ts)
then checks the owning renderer, tab identity, prepared token, and exact
generation. Stale or foreign guests cannot become the current tab's host.

A trusted, unsuppressed pointer event reported by the fixed preload can arm a
clipboard grant for five seconds. The [clipboard policy](../../../apps/desktop/src/features/preview/security/clipboard-trust.ts)
consumes that grant on a permission check and permits only
`clipboard-sanitized-write`. The exact adopted guest must still belong to a
focused window, and the request must match its current main-frame document.
A new main-frame document, guest release, expiry, or a mismatched request
removes permission.

Agent CDP input can produce trusted DOM events, so `event.isTrusted` alone
does not establish human intent. The [guest preload](../../../apps/desktop/src/features/preview/preload/guest-input.ts)
consumes the host's bounded agent-input allowances before reporting human
input or arming clipboard trust. The [automation kernel](../../../apps/desktop/src/features/preview/automation/kernel.ts)
also invokes isolated page code with `userGesture: false`. Synthetic agent
input must not grant the clipboard permission reserved for human interaction.
