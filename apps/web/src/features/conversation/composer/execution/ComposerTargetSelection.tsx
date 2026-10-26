import { useState } from "react";
import { ChevronDown, GitBranch, GitFork } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PICKER_PANEL_CLASS } from "@/components/ui/picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BranchTargetPicker } from "./BranchTargetPicker";
import { StartFromOriginSwitch } from "./StartFromOriginSwitch";
import type { ComposerMode } from "./composer-mode";
import { targetLabelText } from "./new-thread-target-copy";
import { TARGET_TRIGGER_CLASS } from "./target-trigger";
import type { ForkSourceThread } from "./useTargetBranch";
import {
  useForkTargetSelection,
  useNewThreadTargetSelection,
  type ComposerTargetScope,
  type ComposerTargetSelectionProps,
  type ComposerTargetSelectionState,
  type TargetPick,
} from "./useComposerTargetSelection";

export type { ComposerTargetSelectionProps, ComposerTargetScope };

/** Renders branch, pull-request, and worktree choices for new-thread and fork flows in a git project. */
export function ComposerTargetSelection(props: ComposerTargetSelectionProps) {
  if (props.scope === "new-thread") {
    return <NewThreadTargetSelection workspaceId={props.workspaceId} mode={props.mode} />;
  }
  return <ForkTargetSelection sourceThread={props.sourceThread} mode={props.mode} />;
}

function NewThreadTargetSelection({ workspaceId, mode }: { workspaceId: string | undefined; mode: ComposerMode }) {
  return <TargetTriggers selection={useNewThreadTargetSelection(workspaceId, mode)} />;
}

function ForkTargetSelection({ sourceThread, mode }: { sourceThread: ForkSourceThread | undefined; mode: ComposerMode }) {
  return <TargetTriggers selection={useForkTargetSelection(sourceThread, mode)} />;
}

function TargetTriggers({ selection }: { selection: ComposerTargetSelectionState }) {
  const { workspaceId, contextThreadId, target, baseBranch } = selection;
  if (!workspaceId) return null;
  return (
    <>
      <TargetTrigger pick={target} workspaceId={workspaceId} threadId={contextThreadId} testId="composer-branch-trigger" />
      {baseBranch ? (
        <TargetTrigger
          pick={baseBranch}
          workspaceId={workspaceId}
          threadId={contextThreadId}
          testId="composer-base-branch-trigger"
        />
      ) : null}
    </>
  );
}

interface TargetTriggerProps {
  pick: TargetPick;
  workspaceId: string;
  threadId: string | undefined;
  testId: string;
}

function TargetTrigger({ pick, workspaceId, threadId, testId }: TargetTriggerProps) {
  const [open, setOpen] = useState(false);
  const Icon = pick.list === "worktrees" ? GitFork : GitBranch;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="compact"
            data-testid={testId}
            className={cn(TARGET_TRIGGER_CLASS, "min-w-0 shrink")}
          >
            <Icon className="size-3.5" aria-hidden />
            <span className="min-w-0 text-fade">{targetLabelText(pick.label)}</span>
            <ChevronDown className="size-3" aria-hidden />
          </Button>
        }
      />
      {/* The triggers sit right-pinned, so a longer label grows leftward; end alignment keeps the panel still when the Start from origin switch relabels the trigger. */}
      <PopoverContent align="end" side="top" sideOffset={4} className={PICKER_PANEL_CLASS}>
        <BranchTargetPicker
          workspaceId={workspaceId}
          threadId={threadId}
          list={pick.list}
          value={pick.value}
          footer={pick.origin ? <StartFromOriginSwitch origin={pick.origin} /> : undefined}
          onSelect={(picked) => {
            pick.select(picked);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
