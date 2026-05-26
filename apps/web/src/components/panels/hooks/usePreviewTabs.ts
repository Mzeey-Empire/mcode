import { useCallback, useEffect, useState } from "react";
import type { BrowserTabSet } from "@mcode/contracts";
import { usePreviewFocusStore } from "@/stores/previewFocusStore";

/**
 * Renderer-side state + actions for the embedded preview tab bar.
 *
 * Phase A: the host process is the source of truth for tab membership and the
 * active tab. This hook seeds from `preview:tabs.list` on thread mount,
 * reconciles against `preview:tabs-updated` pushes, and exposes thin wrappers
 * for the three mutating IPCs.
 *
 * The hook is a no-op in non-desktop builds (returns `tabSet: null`).
 */
export function usePreviewTabs(threadId: string) {
  const [tabSet, setTabSet] = useState<BrowserTabSet | null>(null);
  const tabs = window.desktopBridge?.preview?.tabs;

  useEffect(() => {
    if (!tabs) return;
    let cancelled = false;
    void tabs.list(threadId).then((r) => {
      if (cancelled) return;
      if (r.ok) setTabSet(r.data);
    });
    const off = tabs.onUpdated((payload) => {
      if (cancelled) return;
      if (payload.threadId === threadId) setTabSet(payload);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [tabs, threadId]);

  const newTab = useCallback(async () => {
    if (!tabs) return;
    const r = await tabs.create(threadId, true);
    if (r.ok) {
      setTabSet(r.data.tabs);
      // A freshly-created tab is empty. Match the panel-open shortcut's UX
      // and put the cursor in the URL field so the user can type a URL
      // immediately without an extra click.
      usePreviewFocusStore.getState().requestOmniboxFocus();
    }
  }, [tabs, threadId]);

  const activateTab = useCallback(
    async (tabId: string) => {
      if (!tabs) return;
      const r = await tabs.activate(threadId, tabId);
      if (r.ok) setTabSet(r.data);
    },
    [tabs, threadId],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      if (!tabs) return;
      const r = await tabs.close(threadId, tabId);
      if (r.ok) setTabSet(r.data);
    },
    [tabs, threadId],
  );

  return { tabSet, newTab, activateTab, closeTab };
}
