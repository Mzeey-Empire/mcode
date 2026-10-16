import { useMemo } from "react";
import { Play, Terminal } from "lucide-react";
import { TERMINAL_MAX_PER_SCOPE } from "@mcode/contracts";
import { PanelHeaderSlot } from "@/components/panels/shell/PanelHeader";
import { PanelTabStrip, type PanelTabStripItem } from "@/components/panels/shell/PanelTabStrip";
import { useTerminalStore, type TerminalInstance } from "@/features/terminal/state/terminalStore";
import { createTerminalForScope } from "@/lib/ensure-terminal";
import { TERMINAL_CAP_REASON } from "./terminalTabs";

interface TerminalTabStripProps {
  readonly scopeId: string;
  readonly terminals: readonly TerminalInstance[];
  readonly activeId: string | null;
  readonly labels: ReadonlyMap<string, string>;
  readonly onClose: (ptyId: string) => void;
}

/** Row 1 of the Terminal tool: one tab per terminal record and a + capped at {@link TERMINAL_MAX_PER_SCOPE}. */
export function TerminalTabStrip({ scopeId, terminals, activeId, labels, onClose }: TerminalTabStripProps) {
  const items = useMemo<readonly PanelTabStripItem[]>(
    () =>
      terminals.map((terminal) => ({
        id: terminal.id,
        label: labels.get(terminal.id) ?? terminal.label,
        icon: terminal.kind === "action" ? <Play aria-hidden /> : <Terminal aria-hidden />,
      })),
    [labels, terminals],
  );
  return (
    <PanelHeaderSlot slot="leading">
      <PanelTabStrip
        items={items}
        activeId={activeId}
        label="Terminals"
        addLabel="New terminal"
        addDisabledReason={terminals.length >= TERMINAL_MAX_PER_SCOPE ? TERMINAL_CAP_REASON : undefined}
        onSelect={(ptyId) => useTerminalStore.getState().setActiveTerminal(scopeId, ptyId)}
        onClose={onClose}
        onAdd={() => createTerminalForScope(scopeId)}
      />
    </PanelHeaderSlot>
  );
}
