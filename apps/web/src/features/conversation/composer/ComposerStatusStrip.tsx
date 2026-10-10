import { TerminalStatusIndicator } from "@/components/chat/TerminalStatusIndicator";
import { basename } from "@/lib/path";
import { cn } from "@/lib/utils";
import type { Thread } from "@/transport";
import { ComposerTargetSelection } from "./execution/ComposerTargetSelection";
import type { ComposerMode } from "./execution/composer-mode";
import { WorkspaceTargetMenu } from "./execution/WorkspaceTargetMenu";

interface ComposerStatusStripProps {
  readonly visible: boolean;
  readonly isGitRepo: boolean;
  readonly branchExecMode: ComposerMode;
  readonly workspacePath: string | undefined;
  readonly activeThread?: Thread;
  readonly onBranchModeChange: (mode: ComposerMode) => void;
}

function ComposerStatusStripContent(props: ComposerStatusStripProps) {
  if (!props.visible) return null;

  return (
    <div className="min-h-0">
      <div className="flex items-center justify-between px-1 pt-1.5">
        <WorkspaceTargetMenu
          mode={props.branchExecMode}
          isGitRepo={props.isGitRepo}
          folder={props.workspacePath ? basename(props.workspacePath) : ""}
          onModeChange={props.onBranchModeChange}
        />
        <div className="flex items-center gap-3">
          <TerminalStatusIndicator />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {props.isGitRepo ? (
            <ComposerTargetSelection scope="branch" mode={props.branchExecMode} sourceThread={props.activeThread} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The fork strip below the input: where the forked thread runs and from which branch. */
export function ComposerStatusStrip(props: ComposerStatusStripProps) {
  return (
    <div
      className={cn(
        "grid overflow-hidden transition-[grid-template-rows,opacity,transform] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
        props.visible ? "grid-rows-[1fr] opacity-100 translate-y-0" : "grid-rows-[0fr] opacity-0 translate-y-1 pointer-events-none",
      )}
      aria-hidden={!props.visible}
      inert={props.visible ? undefined : true}
    >
      <ComposerStatusStripContent {...props} />
    </div>
  );
}
