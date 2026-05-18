import { memo } from "react";
import { Columns2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalStore } from "@/stores/terminalStore";

interface TerminalToolbarProps {
  readonly onAdd: () => void;
  readonly onDeleteAll: () => void;
}

// Stable action ref — avoids a reactive subscription for a function that never changes.
const { toggleSplit } = useTerminalStore.getState();

export const TerminalToolbar = memo(function TerminalToolbar({
  onAdd,
  onDeleteAll,
}: TerminalToolbarProps) {
  const splitMode = useTerminalStore((s) => s.splitMode);

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={toggleSplit}
        className={splitMode ? "text-foreground" : "text-muted-foreground"}
        aria-label="Toggle split mode"
      >
        <Columns2 className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onAdd}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Add terminal"
      >
        <Plus className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onDeleteAll}
        className="text-muted-foreground hover:text-foreground"
        aria-label="Delete all terminals"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  );
});
