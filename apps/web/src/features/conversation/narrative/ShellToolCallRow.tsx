import { type TransitionEvent, useId, useRef, useState } from "react";
import { Check, Clock, Terminal, X } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDuration } from "@/lib/time";
import type { ToolCall } from "@/transport/types";
import {
  NarrativeToolRow,
  NarrativeToolRowDetail,
  NarrativeToolRowMeta,
  type NarrativeToolRowDisclosure,
  type RowExpansion,
  useRowExpansion,
} from "./NarrativeToolRow";
import { ToolOutputTruncationNotice } from "./ToolOutputTruncationNotice";
import { extractNarrativeCommand } from "./extract-narrative-command";

interface ShellToolCallRowProps {
  /** Shell invocation rendered as a nested narrative row. */
  toolCall: ToolCall;
  /** Transcript-owned open state, so the transcript survives row unmounts. */
  expansion?: RowExpansion;
}

/** Formats a completed tool duration in words, such as `1m 5s`; sub-second runs show none. */
function formatToolDuration(durationMs: number | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 1000) return null;
  return formatDuration(Math.round(durationMs / 1000));
}

interface ShellToolCallStatus {
  duration: string | null;
  /** Short outcome for the row meta, such as `failed`. */
  failureMeta: string | null;
  /** Outcome for the transcript footer, such as `exit code 1`. */
  failureLabel: string | null;
  isRunning: boolean;
}

function isShellCallCancelled(toolCall: ToolCall): boolean {
  return toolCall.isCancelled === true || (!toolCall.isComplete && toolCall.isError);
}

function isShellCallRunning(toolCall: ToolCall, isCancelled: boolean): boolean {
  return !toolCall.isComplete && !toolCall.isError && !isCancelled;
}

function shellExitCode(toolCall: ToolCall): number | null {
  return typeof toolCall.exitCode === "number" && Number.isInteger(toolCall.exitCode) ? toolCall.exitCode : null;
}

function shellFailureLabel(toolCall: ToolCall, isCancelled: boolean): string | null {
  if (isCancelled) return "cancelled";
  if (!toolCall.isError) return null;
  const exitCode = shellExitCode(toolCall);
  return exitCode === null ? "failed" : `exit code ${exitCode}`;
}

function shellFailureMeta(toolCall: ToolCall, isCancelled: boolean): string | null {
  if (isCancelled) return "cancelled";
  if (!toolCall.isError) return null;
  return "failed";
}

function shellToolCallStatus(toolCall: ToolCall): ShellToolCallStatus {
  const isCancelled = isShellCallCancelled(toolCall);
  return {
    duration: toolCall.isComplete ? formatToolDuration(toolCall.durationMs) : null,
    failureMeta: shellFailureMeta(toolCall, isCancelled),
    failureLabel: shellFailureLabel(toolCall, isCancelled),
    isRunning: isShellCallRunning(toolCall, isCancelled),
  };
}

/**
 * A finished command reads duration then command; a failed one reads command
 * then `failed · 3s`, so the outcome sits where the eye lands last.
 */
function ShellToolCallHeader({ command, detail, status, disclosure }: {
  command: string;
  detail: string;
  status: ShellToolCallStatus;
  disclosure: NarrativeToolRowDisclosure;
}) {
  const commandDetail = <NarrativeToolRowDetail kind="command" fullText={command || undefined}>{detail}</NarrativeToolRowDetail>;
  const failureMeta = status.failureMeta
    ? [status.failureMeta, status.duration].filter(Boolean).join(" · ")
    : null;
  return (
    <NarrativeToolRow
      icon={Terminal}
      label={status.isRunning ? "Running command" : "Ran command"}
      disclosure={disclosure}
    >
      {!failureMeta && status.duration ? <NarrativeToolRowMeta>{status.duration}</NarrativeToolRowMeta> : null}
      {commandDetail}
      {failureMeta ? <NarrativeToolRowMeta>{failureMeta}</NarrativeToolRowMeta> : null}
    </NarrativeToolRow>
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
  return (
    <section
      id={panelId}
      aria-label="Shell output"
      className="mt-1 min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-hover/25"
    >
      <header className="border-b border-border/50 px-3 py-2 text-sm font-medium text-ink/75">
        {command ? "Shell" : "plaintext"}
      </header>
      {command && (
        <div className="group/copy relative flex min-w-0 items-start gap-2 px-3 py-2 pr-12 font-mono text-xs leading-5">
          <span aria-hidden="true" className="select-none text-muted/70">$</span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-ink/85 [overflow-wrap:anywhere]">
            {command}
          </code>
          <CopyButton text={command} label="Copy command" className="absolute right-2 top-1 text-muted opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
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
            <pre className="w-max min-w-full whitespace-pre px-3 py-2 pr-12 font-mono text-xs leading-5 text-ink/75">
              {toolCall.output}
            </pre>
          </ScrollArea>
          <CopyButton text={toolCall.output} label="Copy output" className="absolute right-3 top-1 bg-hover text-muted opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" />
        </div>
      )}

      <footer className="flex justify-end px-3 py-2">
        <Badge variant="ghost" size="compact" className="gap-1 px-0 font-normal text-muted" role="status">
          {failureLabel ? <X aria-hidden="true" /> : isRunning ? <Clock aria-hidden="true" /> : <Check aria-hidden="true" />}
          {failureLabel ?? (isRunning ? "Running" : "Success")}
        </Badge>
      </footer>
    </section>
  );
}

/** Defers unmounting an open transcript until its collapse animation completes. */
function useCollapsibleTranscriptPresence(open: boolean) {
  const mounted = useRef(open);
  const [, rerender] = useState(0);
  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (open) mounted.current = true;
  else if (reducedMotion) mounted.current = false;

  return {
    present: mounted.current,
    onTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
      if (open || event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
      mounted.current = false;
      rerender((generation) => generation + 1);
    },
  };
}

/** Renders a shell call that reveals a terminal-style command transcript on click. */
export function ShellToolCallRow({ toolCall, expansion }: ShellToolCallRowProps) {
  const { open, onToggle } = useRowExpansion(expansion);
  const panelId = useId();
  const command = extractNarrativeCommand(toolCall);
  const detail = command.replace(/\s+/g, " ").trim() || "Output";
  const status = shellToolCallStatus(toolCall);
  const transcript = useCollapsibleTranscriptPresence(open);

  return (
    <div className="min-w-0 max-w-full">
      <ShellToolCallHeader
        command={command}
        detail={detail}
        status={status}
        disclosure={{
          open,
          onToggle,
          controlsId: transcript.present ? panelId : undefined,
        }}
      />

      <AnimatedCollapsible open={open} onTransitionEnd={transcript.onTransitionEnd}>
        {transcript.present && (
          <ShellToolCallTranscript
            command={command}
            toolCall={toolCall}
            failureLabel={status.failureLabel}
            isRunning={status.isRunning}
            panelId={panelId}
          />
        )}
      </AnimatedCollapsible>
    </div>
  );
}
