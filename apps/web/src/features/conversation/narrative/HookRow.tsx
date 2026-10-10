import { useEffect, useId, useRef, useState } from "react";
import { Webhook } from "lucide-react";
import { AnimatedCollapsible } from "@/components/ui/animated-collapsible";
import type { HookExecution } from "@/transport/types";
import { NarrativeToolRow, NarrativeToolRowDetail, NarrativeToolRowMeta } from "./NarrativeToolRow";
import { getHookOutputLines } from "@/components/chat/hook-output";

interface HookRowProps {
  /** The hook execution to display. */
  hook: HookExecution;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Renders as "Nms" for durations under 1000ms, "N.Ns" for 1000ms and above.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function useHookElapsedSeconds(isRunning: boolean, startedAt: number): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtMsRef = useRef(startedAt);
  startedAtMsRef.current = startedAt;

  useEffect(() => {
    if (!isRunning) return;

    const update = () => {
      setElapsedSeconds(Math.round((Date.now() - startedAtMsRef.current) / 1000));
    };

    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  return elapsedSeconds;
}

function hookMeta(isBlocked: boolean, duration: string | undefined): string | undefined {
  return [isBlocked ? "blocked" : undefined, duration].filter(Boolean).join(" · ") || undefined;
}

function hookDurationLabel(
  isRunning: boolean,
  durationMs: number | undefined,
  elapsedSeconds: number,
): string | undefined {
  if (isRunning) return `${elapsedSeconds}s`;
  if (durationMs == null || durationMs < 5) return undefined;
  return formatDuration(durationMs);
}

function HookOutput({
  fullLines,
  hasOutput,
  isOpen,
  isRunning,
  panelId,
}: {
  fullLines: readonly string[];
  hasOutput: boolean;
  isOpen: boolean;
  isRunning: boolean;
  panelId: string;
}) {
  if (!hasOutput) return null;

  return (
    <AnimatedCollapsible open={isOpen}>
      <pre id={panelId} className="mt-1 ml-6 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/60 bg-hover/25 px-3 py-2 font-mono text-sm leading-5 [overflow-wrap:anywhere]">
        {fullLines.map((line, index) => (
          <span key={`${index}-${line}`} className="block text-sm text-ink/75">
            {line}
            {isRunning && index === fullLines.length - 1 && (
              <span aria-hidden="true" className="typing-cursor" />
            )}
          </span>
        ))}
      </pre>
    </AnimatedCollapsible>
  );
}

/**
 * Collapsed row for one hook execution: "Ran hook", the hook name, its
 * trigger, and a meta such as `blocked · 1.2s`. Rows with
 * output disclose it on click.
 */
export function HookRow({ hook }: HookRowProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const isRunning = hook.status === "running";
  const isBlocked = hook.didBlock === true;
  const { fullLines, hasOutput } = getHookOutputLines(hook);
  const elapsedSeconds = useHookElapsedSeconds(isRunning, hook.startedAt);
  const meta = hookMeta(isBlocked, hookDurationLabel(isRunning, hook.durationMs, elapsedSeconds));

  return (
    <div className="min-w-0 max-w-full">
      <NarrativeToolRow
        icon={Webhook}
        label={isRunning ? "Running hook" : "Ran hook"}
        disclosure={hasOutput ? { open, onToggle: () => setOpen((current) => !current), controlsId: panelId } : undefined}
      >
        <NarrativeToolRowDetail kind="file">{hook.hookName}</NarrativeToolRowDetail>
        {hook.toolName ? <NarrativeToolRowDetail kind="file">{`on ${hook.toolName}`}</NarrativeToolRowDetail> : null}
        {meta ? <NarrativeToolRowMeta>{meta}</NarrativeToolRowMeta> : null}
      </NarrativeToolRow>
      <HookOutput
        fullLines={fullLines}
        hasOutput={hasOutput}
        isOpen={open}
        isRunning={isRunning}
        panelId={panelId}
      />
    </div>
  );
}
