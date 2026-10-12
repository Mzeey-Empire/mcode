import { useEffect, useState, type ReactNode } from "react";
import { AlarmClock, CirclePause } from "lucide-react";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { Button } from "@/components/ui/button";
import { useWorkspaceStore } from "@/features/projects/state/workspaceStore";
import { useThreadRecord } from "@/stores/thread-selectors";
import { clockTime, timeUntil } from "../turn-ending/usage-limit";
import { latestUsageLimitStop, usageLimitTrayState, type UsageLimitTrayState } from "./usage-limit-tray";
import { useUsageLimitActions, type UsageLimitActions } from "./useUsageLimitActions";

const PILL_CLASS = "h-7 rounded-full px-3 text-[length:1.3rem] font-medium bg-warning/18 text-warning hover:bg-warning/26";
// A warning-tinted muted tone, so the secondary actions read as part of the band in either theme.
const GHOST_CLASS = "h-7 px-2 text-[length:1.3rem] font-medium text-[color-mix(in_oklch,var(--color-warning)_40%,var(--color-muted))]";

/** The thread's usage-limit row state; the selector keeps the tray still while unrelated turn state streams. */
export function useUsageLimitTray(threadId: string, running: boolean): UsageLimitTrayState {
  const stop = useThreadRecord(threadId, (record) => latestUsageLimitStop(threadId, record.canonicalAgent.state));
  const scheduledResume = useWorkspaceStore((store) => store.threads.find((thread) => thread.id === threadId)?.scheduled_resume ?? null);
  return usageLimitTrayState(stop, scheduledResume, running);
}

// Re-renders on each minute boundary, so countdowns and a lapsed reset time move at most once a minute.
function useMinuteClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), 60_000 - (now % 60_000));
    return () => window.clearTimeout(timer);
  }, [now]);
  return now;
}

/**
 * Warning band at the top of the composer tray for a turn a provider usage limit stopped: resume it now, at the
 * reset time, or on another model, or cancel the scheduled resume.
 */
export function UsageLimitRow({ threadId, state }: { threadId: string; state: NonNullable<UsageLimitTrayState> }) {
  const actions = useUsageLimitActions(threadId, state.turnId);
  const now = useMinuteClock();
  return (
    <div
      data-testid="usage-limit-row"
      className="@container -mx-2 -mt-1 rounded-t-[1.2rem] bg-warning/8 px-2 inset-ring inset-ring-warning/18"
    >
      <div className="flex h-10 items-center gap-2">
        {state.kind === "limit"
          ? <LimitContent threadId={threadId} state={state} actions={actions} now={now} />
          : <ScheduledContent state={state} actions={actions} now={now} />}
      </div>
    </div>
  );
}

interface LimitContentProps {
  threadId: string;
  state: Extract<UsageLimitTrayState, { kind: "limit" }>;
  actions: UsageLimitActions;
  now: number;
}

function LimitContent({ threadId, state, actions, now }: LimitContentProps) {
  const thread = useWorkspaceStore((store) => store.threads.find((candidate) => candidate.id === threadId));
  const resetsAt = state.resetsAt && Date.parse(state.resetsAt) > now ? state.resetsAt : undefined;
  return (
    <>
      <RowIcon><CirclePause className="size-4 text-warning" strokeWidth={1.5} aria-hidden /></RowIcon>
      <RowLabel
        wide={`${state.provider} usage limit reached`}
        narrow="Usage limit"
        muted={state.limitLabel && ` · ${state.limitLabel}`}
        error={actions.error}
      />
      {thread && (
        <ModelSelector
          selectedModelId={thread.model ?? ""}
          selectedProviderId={thread.provider}
          onSelect={(modelId) => actions.resume(modelId)}
          locked={false}
          // A resume continues on the thread's provider, so only the model can change.
          providerLocked
          trigger={(
            <Button variant="ghost" aria-label="Switch model" disabled={actions.pending} className={GHOST_CLASS}>
              <span className="@max-[440px]:hidden">Switch model</span>
              <span className="hidden @max-[440px]:inline">Switch</span>
            </Button>
          )}
        />
      )}
      <Button
        variant="ghost"
        disabled={actions.pending}
        className={PILL_CLASS}
        onClick={() => (resetsAt ? actions.resumeAt(resetsAt) : actions.resume())}
      >
        {resetsAt ? `Resume at ${clockTime(resetsAt)}` : "Resume"}
      </Button>
    </>
  );
}

interface ScheduledContentProps {
  state: Extract<UsageLimitTrayState, { kind: "scheduled" }>;
  actions: UsageLimitActions;
  now: number;
}

function ScheduledContent({ state, actions, now }: ScheduledContentProps) {
  return (
    <>
      <RowIcon><AlarmClock className="size-4 text-warning" strokeWidth={1.5} aria-hidden /></RowIcon>
      <RowLabel wide={`Resuming at ${clockTime(state.at)}`} muted={` ${timeUntil(state.at, now)}`} error={actions.error} />
      <Button variant="ghost" disabled={actions.pending} className={GHOST_CLASS} onClick={actions.cancel}>
        Cancel
      </Button>
    </>
  );
}

function RowIcon({ children }: { children: ReactNode }) {
  return <span className="flex size-4 shrink-0 items-center justify-center">{children}</span>;
}

interface RowLabelProps {
  wide: string;
  /** Replaces `wide` when the tray is narrower than 440px. */
  narrow?: string;
  muted: string | undefined;
  error: string | null;
}

function RowLabel({ wide, narrow, muted, error }: RowLabelProps) {
  return (
    <span className="text-fade flex-1 text-label text-ink">
      {narrow ? (
        <>
          <span className="@max-[440px]:hidden">{wide}</span>
          <span className="hidden @max-[440px]:inline">{narrow}</span>
        </>
      ) : wide}
      {error
        ? <span role="alert" className="text-error"> · {error}</span>
        : muted && <span className="text-muted">{muted}</span>}
    </span>
  );
}
