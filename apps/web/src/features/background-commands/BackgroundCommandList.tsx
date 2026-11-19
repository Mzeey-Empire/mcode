import { Square, SquareTerminal } from "lucide-react";
import { useId, useState } from "react";
import type { BackgroundCommand } from "@mcode/contracts/models/tool-call-record";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/features/subagents/live-duration";
import { formatLiveDuration } from "@/features/subagents/subagent-status";
import { getTransport } from "@/transport";
import { cn } from "@/lib/utils";
import { OVERVIEW_ROW_CLASS, OverviewRowIcon } from "@/features/thread-overview/overview-row";
import { commandsOf, useBackgroundCommandLoad } from "./backgroundCommandStore";

function StopCommand({ threadId, command }: { threadId: string; command: BackgroundCommand }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  // The row stays until the server's push and reload say the command settled, so success only clears the pending state.
  const stop = async () => {
    setPending(true);
    setError(null);
    try {
      await getTransport().stopBackgroundCommand(threadId, command.toolCallId);
    } catch {
      setError("Stop failed: The command did not stop.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="compact"
        onClick={() => void stop()}
        disabled={pending}
        aria-busy={pending}
        aria-describedby={error ? errorId : undefined}
        aria-label={pending ? `Stopping ${command.label}` : `Stop ${command.label}`}
        className="shrink-0 text-muted hover:text-ink"
      >
        {pending ? <Spinner size={12} /> : <Square size={13} aria-hidden />}
        {pending ? "Stopping…" : "Stop"}
      </Button>
      {error && (
        <span id={errorId} role="alert" className="max-w-48 text-right text-caption text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function CommandRow({ threadId, command, now }: { threadId: string; command: BackgroundCommand; now: number }) {
  return (
    <li className={cn(OVERVIEW_ROW_CLASS, "flex h-auto min-h-row-compact items-center py-1")} aria-label={command.label}>
      <OverviewRowIcon>
        <SquareTerminal />
      </OverviewRowIcon>
      {/* The overview card is narrow, so the tag and time sit under the label rather than squeezing it to a few characters. */}
      <div className="flex min-w-0 grow flex-col">
        <span className="text-fade whitespace-nowrap font-mono text-ink">{command.label}</span>
        <span className="flex items-center gap-1.5 text-caption tabular-nums text-muted">
          {command.awaited && <Badge variant="secondary" size="compact">Awaited</Badge>}
          {formatLiveDuration(now - Date.parse(command.startedAt))}
        </span>
      </div>
      <StopCommand threadId={threadId} command={command} />
    </li>
  );
}

/** Every background command still running in a thread, awaited or not, each with Stop. */
export function BackgroundCommandList({ threadId }: { threadId: string }) {
  const load = useBackgroundCommandLoad(threadId);
  const commands = commandsOf(load) ?? [];
  const now = useNow(commands.length > 0);
  if (load.kind === "failed") {
    return (
      <div className={cn(OVERVIEW_ROW_CLASS, "flex items-center")} role="status" data-testid="background-commands-failed">
        <OverviewRowIcon><SquareTerminal /></OverviewRowIcon>
        <span className="min-w-0 grow font-medium text-ink">Background commands</span>
        <span className="shrink-0 text-caption text-muted">Could not load</span>
      </div>
    );
  }
  if (commands.length === 0) return null;
  return (
    <section aria-label="Background commands">
      {load.kind === "stale" && <p className="px-3 text-caption text-muted">May be out of date</p>}
      <ul>
        {commands.map((command) => (
          <CommandRow key={command.toolCallId} threadId={threadId} command={command} now={now} />
        ))}
      </ul>
    </section>
  );
}
