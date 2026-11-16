import { LAUNCH_USABLE_LIMIT_MS, type RendererLaunchMark } from "@mcode/contracts/launch-telemetry";

const reported = new Set<RendererLaunchMark>();

/** Reports each renderer boundary once, leaving browser-only clients untouched. */
export function reportLaunchMark(name: RendererLaunchMark): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  if (!bridge?.reportLaunchMark || reported.has(name)) return;
  reported.add(name);
  bridge.reportLaunchMark(name, performance.timeOrigin + performance.now());
}

type StartupState = { workspacesLoaded: boolean; threadSnapshotEpoch: number; activeThreadId: string | null };
type StartupStore = { getState(): StartupState; subscribe(listener: () => void): () => void };

/**
 * Observes data hydration and editor readiness until the first usable painted frame. A thread opened before then
 * must also show its transcript, so the frame never counts a loading shell as usable. The deadline starts when
 * `connected` resolves, no earlier than main's usable-frame wait, so slow server startup does not count against it.
 */
export function observeUsableLaunch(store: StartupStore, connected: Promise<unknown>): () => void {
  if (typeof window === "undefined" || !window.desktopBridge?.reportLaunchMark) return () => {};
  let scheduled = false;
  let disposed = false;
  let frame = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(check);
  const unsubscribe = store.subscribe(check);
  void connected.then(() => {
    if (!disposed) timeout = setTimeout(dispose, LAUNCH_USABLE_LIMIT_MS);
  }, dispose);
  function dispose() {
    disposed = true;
    clearTimeout(timeout);
    observer.disconnect();
    unsubscribe();
    cancelAnimationFrame(frame);
  }
  function ready() {
    const state = store.getState();
    return state.workspacesLoaded && state.threadSnapshotEpoch > 0 &&
      document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') !== null &&
      (state.activeThreadId === null || transcriptShown(state.activeThreadId));
  }
  function check() {
    if (disposed || scheduled || !ready()) return;
    scheduled = true;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        scheduled = false;
        if (disposed || !ready()) return;
        reportLaunchMark("usable");
        dispose();
      });
    });
  }
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["contenteditable", "data-lexical-editor", "data-conversation-stage", "data-thread-id"],
  });
  check();
  return dispose;
}

/** Whether the thread's transcript, and not a loading or hold shell, is the conversation on screen. */
export function transcriptShown(threadId: string): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-conversation-stage="messages"]'))
    .some((stage) => stage.dataset.threadId === threadId);
}

/** Records successful first-paint RPC answers at the transport boundary. */
export function reportLaunchResponse(method: string): void {
  if (method === "workspace.list") reportLaunchMark("workspaceListAnswered");
  if (method === "thread.listAll") reportLaunchMark("threadListAnswered");
  if (method === "settings.get") reportLaunchMark("settingsAnswered");
}
