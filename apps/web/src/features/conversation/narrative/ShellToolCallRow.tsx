import { useId, useState } from "react";
import { Check, ChevronRight, Clock, Terminal, X } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import { NARRATIVE_TOOL_ROW, narrativeToolDetailClass } from "./narrative-layout";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { extractNarrativeCommand } from "./extract-narrative-command";

interface ShellToolCallRowProps {
  /** Shell invocation rendered as a nested narrative row. */
  toolCall: ToolCall;
}

/** Formats a completed tool duration for the compact child-row label. */
function formatToolDuration(durationMs: number | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 1000) return null;
  return formatDuration(Math.round(durationMs / 1000));
}

interface ShellToolCallStatus {
  duration: string | null;
  failureLabel: string | null;
  iconClassName: string;
  isRunning: boolean;
}

function isShellCallCancelled(toolCall: ToolCall): boolean {
  return toolCall.isCancelled === true || (!toolCall.isComplete && toolCall.isError);
}

function isShellCallRunning(toolCall: ToolCall, isCancelled: boolean): boolean {
  return !toolCall.isComplete && !toolCall.isError && !isCancelled;
}

function shellFailureLabel(toolCall: ToolCall, isCancelled: boolean): string | null {
  if (isCancelled) return "cancelled";
  if (!toolCall.isError) return null;
  if (typeof toolCall.exitCode === "number" && Number.isInteger(toolCall.exitCode)) {
    return `exit code ${toolCall.exitCode}`;
  }
  return "failed";
}

function shellIconClassName(toolCall: ToolCall, isRunning: boolean): string {
  if (toolCall.isError) return "text-[var(--diff-remove)]";
  if (isRunning) return "text-primary";
  return "text-muted-foreground/70";
}

function shellToolCallStatus(toolCall: ToolCall): ShellToolCallStatus {
  const isCancelled = isShellCallCancelled(toolCall);
  const isRunning = isShellCallRunning(toolCall, isCancelled);
  return {
    duration: toolCall.isComplete ? formatToolDuration(toolCall.durationMs) : null,
    failureLabel: shellFailureLabel(toolCall, isCancelled),
    iconClassName: shellIconClassName(toolCall, isRunning),
    isRunning,
  };
}

function ShellToolCallHeader({
  command,
  detail,
  duration,
  isRunning,
  iconClassName,
  open,
  panelId,
  onToggle,
}: {
  command: string;
  detail: string;
  duration: string | null;
  isRunning: boolean;
  iconClassName: string;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onToggle}
      className={`${NARRATIVE_TOOL_ROW} h-auto w-full justify-start rounded-md px-0 py-1 text-left font-normal transition-colors duration-150 hover:bg-muted/30 aria-expanded:bg-transparent active:translate-y-0 motion-reduce:transition-none dark:hover:bg-muted/30 dark:aria-expanded:bg-transparent`}
      aria-expanded={open}
      aria-controls={panelId}
    >
      <Terminal className={`h-3.5 w-3.5 shrink-0 ${iconClassName}`} />
      <span className="relative shrink-0 text-sm font-medium text-foreground/75">
        {isRunning ? "Running command" : "Ran command"}
        {isRunning && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 text-foreground startup-activity-shimmer startup-activity-shimmer-text"
            data-startup-activity-shimmer-text="Running command"
          />
        )}
      </span>
      {duration && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground/65">
          in {duration}
        </span>
      )}
      {command ? (
        <Tooltip>
          <TooltipTrigger
            render={<span className={narrativeToolDetailClass("md")}>{detail}</span>}
          />
          <TooltipContent>{command}</TooltipContent>
        </Tooltip>
      ) : <span className={narrativeToolDetailClass("md")}>{detail}</span>}
      <ChevronRight
        className={`h-3 w-3 shrink-0 text-muted-foreground/45 transition-transform duration-150 motion-reduce:transition-none ${
          open ? "rotate-90" : ""
        }`}
      />
    </Button>
  );
}

function ShellToolCallTranscript({
  command,
  toolCall,
  failureLabel,
  isRunning,
  panelId,
}: {
  command: string;
  toolCall: ToolCall;
  failureLabel: string | null;
  isRunning: boolean;
  panelId: string;
}) {
  const outputClassName = toolCall.isError
    ? "text-[var(--diff-remove)]"
    : "text-foreground/75";

  return (
    <section
      id={panelId}
      aria-label="Shell output"
      className="mt-1 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/25"
    >
      <header className="border-b border-border/50 px-3 py-2 text-sm font-medium text-foreground/75">
        {command ? "Shell" : "plaintext"}
      </header>
      {command && (
        <div className="group/copy relative flex min-w-0 items-start gap-2 px-3 py-2 pr-12 font-mono text-xs leading-5">
          <span aria-hidden="true" className="select-none text-muted-foreground/70">$</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/85 [overflow-wrap:anywhere]">
            {command}
          </code>
          <CopyButton text={command} label="Copy command" className="absolute right-2 top-1 text-muted-foreground opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
        </div>
      )}

      {toolCall.outputTruncated === true && (
        <div className="px-3 py-2">
          <ToolOutputTruncationNotice toolCall={toolCall} />
        </div>
      )}

      {toolCall.output && (
        <div className="group/copy relative min-w-0">
          <ScrollArea horizontalScrollbar className="max-h-64 min-w-0" viewportClassName="max-h-64" viewportProps={{ "aria-label": "Command output", tabIndex: 0 }}>
            <pre className={`w-max min-w-full whitespace-pre px-3 py-2 pr-12 font-mono text-xs leading-5 ${outputClassName}`}>
              {toolCall.output}
            </pre>
          </ScrollArea>
          <CopyButton text={toolCall.output} label="Copy output" className="absolute right-3 top-1 bg-muted text-muted-foreground opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
        </div>
      )}

      <footer className="flex justify-end px-3 py-2">
        <Badge variant="ghost" size="sm" className="gap-1 px-0 font-normal text-muted-foreground" role="status">
          {failureLabel ? <X aria-hidden="true" /> : isRunning ? <Clock aria-hidden="true" /> : <Check aria-hidden="true" />}
          {failureLabel ?? (isRunning ? "Running" : "Success")}
        </Badge>
      </footer>
    </section>
  );
}

/** Renders a nested shell call that reveals a terminal-style command transcript. */
export function ShellToolCallRow({ toolCall }: ShellToolCallRowProps) {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const panelId = useId();
  const command = extractNarrativeCommand(toolCall);
  const detail = command.replace(/\s+/g, " ").trim() || "Output";
  const status = shellToolCallStatus(toolCall);
  const open = manualOpen ?? status.isRunning;

  return (
    <div className="min-w-0 max-w-full">
      <ShellToolCallHeader
        command={command}
        detail={detail}
        duration={status.duration}
        isRunning={status.isRunning}
        iconClassName={status.iconClassName}
        open={open}
        panelId={panelId}
        onToggle={() => setManualOpen(!open)}
      />

      <AnimatedCollapsible open={open}>
        <ShellToolCallTranscript
          command={command}
          toolCall={toolCall}
          failureLabel={status.failureLabel}
          isRunning={status.isRunning}
          panelId={panelId}
        />
      </AnimatedCollapsible>
    </div>
  );
}
