import { useEffect, useRef } from "react";
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getTransport } from "@/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { shouldInterceptKeyEvent } from "./terminalKeyHandler";
import { ClientTerminalFlowControl } from "./terminalFlowControl";
// Static import so bundler deduplicates the stylesheet
import "@xterm/xterm/css/xterm.css";

/**
 * Dev-only live-terminal counter. Exposed on `window.__mcodeLiveTerminals`
 * so Playwright can assert that every terminal is disposed after close/
 * thread-switch. Guarded by `import.meta.env.DEV` so production bundles
 * pay zero cost.
 */
type LiveTerminalWindow = Window & { __mcodeLiveTerminals?: number };

function incrementLiveTerminalCount(): void {
  if (!import.meta.env.DEV) return;
  const w = window as LiveTerminalWindow;
  w.__mcodeLiveTerminals = (w.__mcodeLiveTerminals ?? 0) + 1;
}

function decrementLiveTerminalCount(): void {
  if (!import.meta.env.DEV) return;
  const w = window as LiveTerminalWindow;
  w.__mcodeLiveTerminals = Math.max(0, (w.__mcodeLiveTerminals ?? 1) - 1);
}

// Ensures the counter starts at 0 on module load in dev so the first
// Playwright assertion has a stable baseline.
if (import.meta.env.DEV) {
  const w = window as LiveTerminalWindow;
  if (typeof w.__mcodeLiveTerminals !== "number") {
    w.__mcodeLiveTerminals = 0;
  }
}

/**
 * Dev-only active-renderer sentinel. Exposed on
 * `window.__mcodeActiveRenderer` so Playwright can assert which renderer
 * (WebGL addon vs xterm's built-in DOM renderer) is currently active.
 * Guarded by `import.meta.env.DEV` so production bundles pay zero cost.
 *
 * The "canvas" addon was removed from xterm.js v6, so the fallback path
 * now relies on xterm's built-in DOM renderer, which auto-attaches when
 * no renderer addon is loaded.
 */
type ActiveRendererWindow = Window & { __mcodeActiveRenderer?: "webgl" | "dom" };

function setActiveRenderer(name: "webgl" | "dom"): void {
  if (!import.meta.env.DEV) return;
  (window as ActiveRendererWindow).__mcodeActiveRenderer = name;
}

/**
 * Clears the dev-only active-renderer sentinel. Called on terminal
 * teardown so the sentinel does not report a stale renderer name after
 * the component unmounts.
 */
function clearActiveRenderer(): void {
  if (!import.meta.env.DEV) return;
  delete (window as ActiveRendererWindow).__mcodeActiveRenderer;
}

/**
 * Cached WebGL support result. Memoized at module scope so the probe
 * context is created at most once per session — browsers cap concurrent
 * GL contexts (~8–16) and repeated mounts would otherwise evict the
 * terminal's real WebGL context.
 */
let cachedWebglSupport: boolean | null = null;

/**
 * Returns true if the browser can create a WebGL context. Uses a throwaway
 * canvas so it does not mutate the terminal's own canvas during detection.
 * Result is memoized; the probe context is released immediately via
 * WEBGL_lose_context so it does not count against the browser's
 * concurrent-context cap.
 */
function detectWebglSupport(): boolean {
  if (cachedWebglSupport !== null) return cachedWebglSupport;
  try {
    const c = document.createElement("canvas");
    const ctx = c.getContext("webgl2") ?? c.getContext("webgl");
    if (ctx) {
      // Release the probe context immediately so it doesn't count against
      // the browser's concurrent-GL-context cap.
      const lose = (ctx as WebGLRenderingContext).getExtension(
        "WEBGL_lose_context",
      );
      lose?.loseContext();
    }
    cachedWebglSupport = ctx !== null;
  } catch {
    cachedWebglSupport = false;
  }
  return cachedWebglSupport;
}

/**
 * Attempts to load the WebGL renderer. On success, installs an
 * `onContextLoss` handler that disposes the WebGL addon for the rest of
 * this terminal's session (no retry — context loss typically recurs
 * under the same conditions) and lets xterm's built-in DOM renderer
 * take over. On any failure (no GPU context, addon construction throw),
 * or if the component has unmounted, leaves the built-in DOM renderer
 * as the active renderer.
 *
 * xterm.js v6 removed the standalone canvas renderer addon, so the
 * fallback is now the DOM renderer that xterm auto-attaches whenever no
 * renderer addon is loaded (or when a loaded addon is disposed).
 *
 * Because the active renderer can change at runtime (WebGL → DOM swap),
 * the caller passes a ref object whose `current` this function
 * reassigns so that cleanup always disposes the addon actually mounted.
 *
 * The module-import await is followed by `isDisposed()` checks so a
 * racing unmount cannot attach an addon to an already-disposed terminal
 * or leave a constructed addon leaked with no owner.
 */
async function loadRenderer(
  term: Terminal,
  rendererRef: { current: IDisposable | null },
  isDisposed: () => boolean,
): Promise<void> {
  if (detectWebglSupport()) {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      if (isDisposed()) return;
      const webgl = new WebglAddon();
      if (isDisposed()) {
        try {
          webgl.dispose();
        } catch {
          // Defensive: addon may have internal state that throws.
        }
        return;
      }
      try {
        term.loadAddon(webgl);
      } catch (err) {
        // Construction succeeded but attach failed — dispose the orphaned
        // addon before rethrowing so the outer catch falls through to the
        // DOM renderer without leaking the partially-initialised WebglAddon.
        try {
          webgl.dispose();
        } catch {
          // Defensive: addon may have internal state that throws.
        }
        throw err;
      }
      rendererRef.current = webgl;
      setActiveRenderer("webgl");
      webgl.onContextLoss(() => {
        // Dispose WebGL; xterm automatically falls back to its built-in
        // DOM renderer when a loaded renderer addon is disposed. The
        // xterm buffer is renderer-independent, so this repaints the
        // existing output without needing a snapshot/restore dance.
        try {
          webgl.dispose();
        } catch {
          // Already disposed by a racing cleanup — safe to ignore.
        }
        if (isDisposed()) return;
        rendererRef.current = null;
        setActiveRenderer("dom");
      });
      return;
    } catch (err) {
      // WebGL addon construction failed; fall through to DOM unless we
      // were disposed during the await.
      if (isDisposed()) return;
      console.warn(
        "[terminal] WebGL renderer init failed, falling back to DOM",
        err,
      );
    }
  }
  // No renderer addon attached → xterm's built-in DOM renderer is active.
  setActiveRenderer("dom");
}

/** Props for {@link TerminalView}. */
interface TerminalViewProps {
  /** The PTY session ID this view is bound to. */
  readonly ptyId: string;
  /** Whether the terminal panel is currently visible. Controls display style. */
  readonly visible: boolean;
}

/** Renders a single xterm.js terminal backed by a server-side PTY via WS transport. */
export function TerminalView({ ptyId, visible }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const flushResizeRpcRef = useRef<(() => void) | null>(null);
  const rendererRef = useRef<IDisposable | null>(null);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const scrollback = useSettingsStore((s) => s.settings.terminal.scrollback);
  const scrollbackRef = useRef(scrollback);
  scrollbackRef.current = scrollback;

  // Mount terminal
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    async function init(el: HTMLElement) {
      const [{ Terminal: XTerminal }, { FitAddon: XFitAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);

      if (disposed || !containerRef.current) return;

      const term = new XTerminal({
        scrollback: scrollbackRef.current,
        fontSize: 13,
        fontFamily: "monospace",
        theme: {
          background: "#0a0a0f",
          foreground: "#e4e4e7",
          cursor: "#e4e4e7",
        },
      });

      const fitAddon = new XFitAddon();
      term.loadAddon(fitAddon);
      term.open(el);
      incrementLiveTerminalCount();

      // Intercept Ctrl/Cmd+C when text is selected — copy to clipboard instead of sending SIGINT.
      // Returning false prevents xterm from forwarding the raw \x03 byte to the PTY.
      // getSelection() is called first to avoid a TOCTOU race with hasSelection().
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        const selection = term.getSelection();
        if (shouldInterceptKeyEvent(event, selection.length > 0)) {
          if (selection) {
            navigator.clipboard.writeText(selection).catch(() => {});
          }
          return false;
        }
        return true;
      });

      fitAddon.fit();

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const transport = getTransport();

      const flowSettings =
        useSettingsStore.getState().settings.terminal.flowControl;
      const fc = new ClientTerminalFlowControl({
        onPause: () => transport.terminalPause(ptyId).catch(() => {}),
        onResume: () => transport.terminalResume(ptyId).catch(() => {}),
        highBytes: flowSettings.clientHighBytes,
        lowBytes: flowSettings.clientLowBytes,
      });

      // Right-click pastes clipboard text into the PTY (native terminal convention — no context menu).
      // term.paste() is used instead of transport.terminalWrite() so that xterm applies bracketed
      // paste mode when the shell requests it, preventing embedded newlines from auto-executing commands.
      const handleContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              term.paste(text);
            }
          })
          .catch(() => {});
      };
      el.addEventListener("contextmenu", handleContextMenu);

      // Forward keystrokes to the backend via WS RPC
      const dataDisposable = term.onData((data) => {
        transport.terminalWrite(ptyId, data).catch(() => {});
      });

      // Listen for PTY output via push channel (CustomEvent dispatched by ws-events).
      // Attached BEFORE awaiting the renderer so initial PTY output that arrives
      // during renderer initialization is buffered into the xterm write queue
      // (term.write is renderer-independent) and painted as soon as a renderer
      // is attached — never dropped.
      const handlePtyData = (e: Event) => {
        const detail = (e as CustomEvent).detail as {
          ptyId: string;
          payload: Uint8Array;
          seq: number;
        };
        if (detail.ptyId !== ptyId) return;
        // Track last-seen seq so the reconnect handler can call terminal.reattach
        // with the correct lastSeq, minimising replayed output on reconnect.
        transport.ptySetLastSeq(ptyId, detail.seq);
        const n = detail.payload.length;
        fc.written(n);
        // Use xterm's callback form so acked() fires only after the bytes
        // are committed to the terminal buffer — not just queued.
        term.write(detail.payload, () => fc.acked(n));
      };
      window.addEventListener("mcode:pty-data", handlePtyData);

      // Show a reconnect banner when the server signals that the replay window
      // was exceeded and some output may have been missed.
      const handleReconnectGap = (e: Event) => {
        const detail = (e as CustomEvent).detail as { ptyId: string };
        if (detail.ptyId !== ptyId) return;
        term.write("\r\n\x1b[90m[Reconnected - some output may be missing]\x1b[0m\r\n");
      };
      window.addEventListener("mcode:pty-reconnect-gap", handleReconnectGap);

      // Listen for PTY exit via push channel (attached pre-renderer for the
      // same reason as pty-data: an early exit should not be silently lost).
      const handlePtyExit = (e: Event) => {
        const detail = (e as CustomEvent).detail as {
          ptyId: string;
          code: number;
        };
        if (detail.ptyId === ptyId) {
          term.write(
            `\r\n\x1b[90m[Process exited with code ${detail.code}]\x1b[0m\r\n`,
          );
        }
      };
      window.addEventListener("mcode:pty-exit", handlePtyExit);

      // Resize handling:
      //
      // ResizeObserver can fire every animation frame during drag. Two distinct
      // concerns, two strategies:
      //   - Local fitAddon.fit() is cheap and keeps the terminal visibly aligned
      //     during drag → coalesce to one call per animation frame via rAF.
      //   - The terminal.resize RPC is expensive (WS → node-pty → shell repaint)
      //     → debounce to a single trailing call 100 ms after the last change.
      //
      // Skip RPCs where the character grid (cols, rows) has not changed — drags
      // that move by less than one cell of pixels otherwise send no-op resizes.
      let rafId: number | null = null;
      let rpcTimer: ReturnType<typeof setTimeout> | null = null;
      let lastSentCols = -1;
      let lastSentRows = -1;

      const flushResizeRpc = () => {
        // Clear any pending timeout so a manual flush (e.g. from the
        // visibility effect) supersedes the scheduled trailing call
        // instead of racing with it. Without this, a later timer fire
        // could double-send the resize RPC or send stale dimensions.
        if (rpcTimer !== null) {
          clearTimeout(rpcTimer);
          rpcTimer = null;
        }
        if (disposed) return;
        const dims = fitAddonRef.current?.proposeDimensions();
        if (!dims || dims.cols <= 0 || dims.rows <= 0) return;
        if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
        lastSentCols = dims.cols;
        lastSentRows = dims.rows;
        transport.terminalResize(ptyId, dims.cols, dims.rows).catch(() => {});
      };
      flushResizeRpcRef.current = flushResizeRpc;

      const observer = new ResizeObserver(() => {
        if (disposed || !fitAddonRef.current) return;
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (disposed) return;
            fitAddonRef.current?.fit();
          });
        }
        if (rpcTimer !== null) clearTimeout(rpcTimer);
        rpcTimer = setTimeout(flushResizeRpc, 100);
      });
      observer.observe(el);

      const cleanup = () => {
        if (rafId !== null) cancelAnimationFrame(rafId);
        if (rpcTimer !== null) clearTimeout(rpcTimer);
        flushResizeRpcRef.current = null;
        dataDisposable.dispose();
        el.removeEventListener("contextmenu", handleContextMenu);
        window.removeEventListener("mcode:pty-data", handlePtyData);
        window.removeEventListener("mcode:pty-reconnect-gap", handleReconnectGap);
        window.removeEventListener("mcode:pty-exit", handlePtyExit);
        transport.ptyDeleteLastSeq(ptyId);
        observer.disconnect();
        try {
          rendererRef.current?.dispose();
        } catch {
          // Renderer may already be disposed by a racing context-loss swap,
          // or the renderer never attached because loadRenderer aborted on a
          // mid-await disposal. Either way, nothing left to release here.
        }
        rendererRef.current = null;
        clearActiveRenderer();
        term.dispose();
        decrementLiveTerminalCount();
      };

      // Register cleanup BEFORE awaiting the renderer so a mid-await unmount
      // can reach it via React's teardown path, and so PTY events delivered
      // during the await are handled by listeners that already have a known
      // disposal pathway. term.write() queues into the xterm buffer even
      // before a renderer is attached, so no initial output is lost.
      cleanupRef.current = cleanup;

      if (disposed) {
        cleanup();
        cleanupRef.current = null;
        return;
      }

      // New PTYs are created paused server-side so their initial shell prompt
      // is buffered until this view is ready to consume it. Resume only after
      // the PTY listeners above are attached; term.write queues bytes even
      // before the renderer addon finishes loading. Guard with the current
      // visibility state so a late init doesn't race with pause-on-hide.
      if (visibleRef.current) {
        transport.terminalResume(ptyId).catch(() => {});
      }

      await loadRenderer(term, rendererRef, () => disposed);
      // If `disposed` flipped during the await, React's effect teardown
      // already invoked cleanupRef.current, and loadRenderer's own
      // isDisposed() guards ensured no renderer addon was attached to the
      // now-disposed terminal. No post-await work is required.
    }

    // init() awaits dynamic imports and may construct/attach xterm before
    // cleanupRef is registered. If any of those steps reject, flip the
    // disposed latch and run whatever cleanup has been wired up so no
    // partial state (live counter increment, attached listeners) leaks.
    void init(container).catch((err) => {
      console.warn("[terminal] Failed to initialize terminal", err);
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    });

    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ptyId]);

  // When the panel is toggled open (visible: false -> true) we refit,
  // repaint, and intentionally pull focus into xterm so the user can start
  // typing immediately. Focus is deliberately NOT moved on window/tab
  // return — doing so would steal focus from the composer whenever the
  // user alt-tabs back, contradicting the Ctrl+J-from-composer workflow.
  // Flushing the debounced resize RPC ensures the PTY learns the new dims
  // without waiting for the 100 ms debounce tail.
  useEffect(() => {
    if (!visible) return;
    const term = termRef.current;
    if (!term) return;
    fitAddonRef.current?.fit();
    flushResizeRpcRef.current?.();
    term.refresh(0, term.rows - 1);
    term.focus();
  }, [visible]);

  // Repaint xterm's DOM renderer when the window/tab regains visibility.
  // Long background stints leave the canvas half-painted; fit + refresh is
  // idempotent and cheap, and crucially skips term.focus() so we don't
  // yank focus out of whatever the user was typing in (issue #305).
  useEffect(() => {
    const repaint = () => {
      if (!visible) return;
      const term = termRef.current;
      if (!term) return;
      fitAddonRef.current?.fit();
      term.refresh(0, term.rows - 1);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") repaint();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", repaint);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", repaint);
    };
  }, [visible]);

  // Sync scrollback setting to live terminal without remounting
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.scrollback = scrollback;
    }
  }, [scrollback]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ display: visible ? "block" : "none" }}
    />
  );
}
