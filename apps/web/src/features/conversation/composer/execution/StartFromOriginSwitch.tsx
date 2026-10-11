import { useId } from "react";

import { Switch } from "@/components/ui/switch";
import type { OriginSwitch } from "./useComposerTargetSelection";

/** The "Start from origin" row a New worktree branch picker shows under its Branches list. */
export function StartFromOriginSwitch({ origin }: { readonly origin: OriginSwitch }) {
  const id = useId();
  return (
    <div className="flex items-center gap-3" data-testid="start-from-origin">
      <label htmlFor={id} className="min-w-0 grow cursor-pointer select-none text-label text-ink">
        Start from origin
      </label>
      <Switch id={id} checked={origin.checked} disabled={origin.forced} onCheckedChange={origin.set} />
    </div>
  );
}
