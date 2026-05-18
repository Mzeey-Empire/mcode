import { useMemo } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminalStore";
import { TerminalView } from "./TerminalView";

/**
 * Persistent container for dormant terminal views (non-active threads).
 *
 * Rendered at the App root so xterm instances survive thread switches
 * without remounting. WebGL is disposed via `threadActive={false}` to
 * save GPU memory; the xterm buffer (scrollback) stays intact.
 *
 * The container uses `sr-only` (screen-reader-only) positioning so it
 * consumes zero layout space and triggers no paints.
 */
export function DormantTerminals() {
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId);
  const allTerminals = useTerminalStore((s) => s.terminals);
  const allPanels = useTerminalStore((s) => s.terminalPanelByThread);

  const dormantTerminals = useMemo(() => {
    const result: Array<{ term: TerminalInstance; activeInTab: boolean }> = [];
    for (const [threadId, instances] of Object.entries(allTerminals)) {
      if (threadId === activeThreadId) continue;
      const panel = allPanels[threadId];
      const activeTab = panel?.activeTerminalId ?? null;
      for (const term of instances) {
        result.push({ term, activeInTab: term.id === activeTab });
      }
    }
    return result;
  }, [allTerminals, allPanels, activeThreadId]);

  if (dormantTerminals.length === 0) return null;

  return (
    <div className="sr-only" aria-hidden="true">
      {dormantTerminals.map((d) => (
        <TerminalView
          key={d.term.id}
          ptyId={d.term.id}
          visible={false}
          threadActive={false}
        />
      ))}
    </div>
  );
}
