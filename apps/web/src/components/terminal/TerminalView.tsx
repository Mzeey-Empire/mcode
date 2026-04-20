import { useEffect, useRef } from "react";
import type { Terminal, IDisposable } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { getTransport } from "@/transport";
import { useSettingsStore } from "@/stores/settingsStore";
import { shouldInterceptKeyEvent } from "./terminalKeyHandler";
import { CLEAR_TERMINAL_BUFFERS_EVENT } from "@/hooks/useIdleReclamation";
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
 * (WebGL vs canvas) xterm is currently using. Guarded by
 * `import.meta.env.DEV` so production bundles pay zero cost.
 */
type ActiveRendererWindow = Window & { __mcodeActiveRenderer?: "webgl" | "canvas" };

function setActiveRenderer(name: "webgl" | "canvas"): void {
  if (!import.meta.env.DEV) return;
  (window as ActiveRendererWindow).__mcodeActiveRenderer = name;
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
 * Loads the canvas renderer addon and registers the renderer name.
 * Returns the addon instance so the caller can track it for cleanup.
 */
async function loadCanvasRenderer(term: Terminal): Promise<IDisposable> {
  const { CanvasAddon } = await import("@xterm/addon-canvas");
  const canvas = new CanvasAddon();
  term.loadAddon(canvas);
  setActiveRenderer("canvas");
  return canvas;
}

/**
 * Attempts to load the WebGL renderer. On success, installs an
 * `onContextLoss` handler that disposes the WebGL addon and permanently
 * swaps to the canvas addon for the rest of this terminal's session
 * (no retry — context loss typically recurs under the same conditions).
 * On any failure (no GPU context, addon construction throw), falls back
 * to canvas immediately.
 *
 * Because the active addon can change at runtime (WebGL → canvas swap),
 * the caller passes a ref object whose `current` this function reassigns
 * so that cleanup always disposes the addon that is actually mounted.
 */
async function loadRenderer(
  term: Terminal,
  rendererRef: { current: IDisposable | null },
  isDisposed: () => boolean,
): Promise<void> {
  if (detectWebglSupport()) {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
      rendererRef.current = webgl;
      setActiveRenderer("webgl");
      webgl.onContextLoss(() => {
        // Dispose WebGL and swap to canvas. The xterm buffer is
        // renderer-independent, so this repaints the existing output
        // without needing a snapshot/restore dance.
        try {
          webgl.dispose();
        } catch {
          // Already disposed by a racing cleanup — safe to ignore.
        }
        // Inline construction so the disposed-check can run between
        // `new CanvasAddon()` and `term.loadAddon(canvas)`. The public
        // `loadCanvasRenderer` helper loads the addon internally, which
        // would be a side effect against a disposed terminal if we
        // awaited it here.
        import("@xterm/addon-canvas")
          .then(({ CanvasAddon }) => {
            const canvas = new CanvasAddon();
            // If the component unmounted while the canvas module was
            // loading, dispose the freshly-constructed addon without
            // ever attaching it to the (potentially disposed) terminal.
            if (isDisposed()) {
              try {
                canvas.dispose();
              } catch {
                // Defensive: addon may have internal state that throws
                // even before loadAddon. Safe to ignore.
              }
              return;
            }
            term.loadAddon(canvas);
            rendererRef.current = canvas;
            setActiveRenderer("canvas");
          })
          .catch((err) => {
            // Canvas load failed after WebGL context loss. xterm does
            // not auto-attach a DOM renderer when no renderer addon is
            // loaded, so the terminal buffer will be static until
            // unmount. Nothing else to do here — the session is
            // effectively read-only rendering.
            console.warn(
              "[terminal] Canvas renderer load failed after WebGL context loss; " +
                "xterm does not auto-attach a DOM renderer, so the terminal " +
                "buffer is now static until unmount.",
              err,
            );
          });
      });
      return;
    } catch (err) {
      // WebGL addon construction failed; fall through to canvas.
      console.warn(
        "[terminal] WebGL renderer init failed, falling back to canvas",
        err,
      );
    }
  }
  rendererRef.current = await loadCanvasRenderer(term);
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

      await loadRenderer(term, rendererRef, () => disposed);
      if (disposed) return;

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const transport = getTransport();

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

      // Listen for PTY output via push channel (CustomEvent dispatched by ws-events)
      const handlePtyData = (e: Event) => {
        const detail = (e as CustomEvent).detail as {
          ptyId: string;
          data: string;
        };
        if (detail.ptyId === ptyId && typeof detail.data === "string") {
          term.write(detail.data);
        }
      };
      window.addEventListener("mcode:pty-data", handlePtyData);

      // Listen for PTY exit via push channel
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
        rpcTimer = null;
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
        window.removeEventListener("mcode:pty-exit", handlePtyExit);
        observer.disconnect();
        try {
          rendererRef.current?.dispose();
        } catch {
          // Renderer may already be disposed by a racing context-loss swap.
        }
        rendererRef.current = null;
        term.dispose();
        decrementLiveTerminalCount();
      };

      // Set cleanupRef BEFORE the disposed check so the effect's
      // synchronous teardown can always reach it, even if it races
      // with this async init completing.
      cleanupRef.current = cleanup;

      if (disposed) {
        cleanup();
        cleanupRef.current = null;
        return;
      }
    }

    init(container);

    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [ptyId]);

  // Re-fit when visibility changes (ResizeObserver handles the rest).
  // Flush any pending debounced resize RPC so the PTY learns the new dims
  // without waiting for the 100 ms debounce tail.
  useEffect(() => {
    if (visible && fitAddonRef.current) {
      fitAddonRef.current.fit();
      flushResizeRpcRef.current?.();
    }
  }, [visible]);

  // Clear scrollback buffer during background idle to release memory
  useEffect(() => {
    const handleClearBuffers = () => {
      termRef.current?.clear();
    };
    window.addEventListener(CLEAR_TERMINAL_BUFFERS_EVENT, handleClearBuffers);
    return () => {
      window.removeEventListener(CLEAR_TERMINAL_BUFFERS_EVENT, handleClearBuffers);
    };
  }, []);

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
