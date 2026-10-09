import {
  getThreadStartupPhases,
  type ThreadStartup,
  type ThreadStartupKind,
  type ThreadStartupPhase,
  type ThreadStartupStep,
  type ThreadStartupStepState,
} from "@mcode/contracts";

/** Startup phases the trail draws. The "thread" phase is bookkeeping and never renders. */
export type TrailPhase = Exclude<ThreadStartupPhase, "thread">;

/** Visual treatment of one trail row, mapped from its step state. */
export type TrailRowTone = "done" | "live" | "pending" | "failed" | "skipped" | "cancelled";

/** One rendered step of the startup trail. */
export interface StartupTrailRow {
  readonly phase: TrailPhase;
  readonly tone: TrailRowTone;
  readonly label: string;
  /** Mono muted segments after the label: the argument, then the duration. */
  readonly meta: readonly string[];
  /** Full value behind a shortened argument, such as the worktree path. */
  readonly title?: string;
  /** Whether the row can expand into the setup output card. */
  readonly expandable: boolean;
}

/** The single line a started trail collapses to. */
export interface StartupTrailSummary {
  readonly duration: string;
  readonly parts: readonly string[];
}

interface StepVerbs {
  readonly pending: string;
  readonly running: string;
  readonly completed: string;
  readonly failed: string;
  readonly skipped: string;
  /** Subject for "{name} stopped". */
  readonly name: string;
}

const FETCH: StepVerbs = { pending: "Fetch", running: "Fetching", completed: "Fetched", failed: "Fetch failed", skipped: "Skipped fetch", name: "Fetch" };
const CREATE_WORKTREE: StepVerbs = { pending: "Create worktree", running: "Creating worktree", completed: "Created worktree", failed: "Worktree failed", skipped: "Skipped worktree", name: "Worktree" };
const OPEN_WORKTREE: StepVerbs = { pending: "Open worktree", running: "Opening worktree", completed: "Opened worktree", failed: "Worktree failed", skipped: "Skipped worktree", name: "Worktree" };
const SETUP: StepVerbs = { pending: "Run setup", running: "Running setup", completed: "Ran setup", failed: "Setup failed", skipped: "Skipped setup", name: "Setup" };
const AGENT: StepVerbs = { pending: "Start thread", running: "Starting thread", completed: "Started thread", failed: "Thread didn't start", skipped: "Skipped start", name: "Thread start" };

const TONE_BY_STATE: Record<ThreadStartupStepState, TrailRowTone> = {
  pending: "pending",
  running: "live",
  // The server blocks a startup only when setup fails or cannot launch, so a blocked step reads as failed.
  blocked: "failed",
  completed: "done",
  failed: "failed",
  // An interrupted step offers the failed-state actions, so it reads as failed.
  interrupted: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
};

const SKIP_REASON_COPY: Record<"not-configured" | "thread-running-here", string> = {
  "not-configured": "not configured",
  "thread-running-here": "thread running here",
};

/** Formats elapsed milliseconds as mono `m:ss`, the only duration form the trail uses. */
export function formatStartupDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The first command line of a setup script, which stands in for the whole script in one row. */
export function setupCommandLine(script: string | null | undefined): string | undefined {
  return script?.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
}

function opensWorktree(kind: ThreadStartupKind, step: ThreadStartupStep): boolean {
  if (step.detail?.phase === "worktree") return step.detail.mode === "opened";
  return kind === "attached-worktree";
}

function verbsFor(kind: ThreadStartupKind, step: ThreadStartupStep & { phase: TrailPhase }): StepVerbs {
  switch (step.phase) {
    case "fetch":
      return FETCH;
    case "worktree":
      return opensWorktree(kind, step) ? OPEN_WORKTREE : CREATE_WORKTREE;
    case "setup":
      return SETUP;
    case "agent":
      return AGENT;
  }
}

/** Maps one step to its visible label from the phase, state and detail. */
export function startupStepLabel(kind: ThreadStartupKind, step: ThreadStartupStep & { phase: TrailPhase }): string {
  const verbs = verbsFor(kind, step);
  switch (step.state) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "skipped":
      return verbs[step.state];
    case "blocked":
      return verbs.failed;
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return `${verbs.name} stopped`;
  }
}

type SetupDetail = Extract<NonNullable<ThreadStartupStep["detail"]>, { phase: "setup" }>;

/** A user-skipped setup needs no reason; the others explain why setup did not run. */
function skipReasonCopy(detail: SetupDetail | undefined): string | undefined {
  const reason = detail?.skipReason;
  return reason && reason !== "user-skipped" ? SKIP_REASON_COPY[reason] : undefined;
}

function setupArgument(step: ThreadStartupStep, setupCommand: string | undefined): string | undefined {
  const detail = step.detail?.phase === "setup" ? step.detail : undefined;
  if (step.state === "skipped") return skipReasonCopy(detail);
  if ((step.state === "failed" || step.state === "blocked") && detail?.exitCode !== undefined) return `exit ${detail.exitCode}`;
  return step.state === "pending" ? undefined : setupCommand;
}

function stepArgument(step: ThreadStartupStep, setupCommand: string | undefined): string | undefined {
  if (step.detail?.phase === "fetch") return step.detail.ref;
  if (step.detail?.phase === "worktree") return step.detail.folderName;
  return step.phase === "setup" ? setupArgument(step, setupCommand) : undefined;
}

/** Steps that do no timed work show no duration: pending, skipped and an opened worktree. */
function showsDuration(kind: ThreadStartupKind, step: ThreadStartupStep): boolean {
  if (step.state === "pending" || step.state === "skipped") return false;
  return !(step.phase === "worktree" && opensWorktree(kind, step));
}

function stepDuration(kind: ThreadStartupKind, step: ThreadStartupStep, now: number): string | undefined {
  if (!step.startedAt || !showsDuration(kind, step)) return undefined;
  const end = step.endedAt ? Date.parse(step.endedAt) : step.state === "running" ? now : undefined;
  return end === undefined ? undefined : formatStartupDuration(end - Date.parse(step.startedAt));
}

// A stopped setup keeps its output open, since that output is what explains the stop.
const SETUP_OUTPUT_STATES: ReadonlySet<ThreadStartupStepState> = new Set(["running", "blocked", "failed", "interrupted"]);

function isTrailStep(step: ThreadStartupStep): step is ThreadStartupStep & { phase: TrailPhase } {
  return step.phase !== "thread";
}

/** Builds the visible trail rows for one startup record at wall-clock time `now`. */
export function startupTrailRows(
  startup: Pick<ThreadStartup, "kind" | "steps">,
  { now, setupCommand }: { readonly now: number; readonly setupCommand?: string },
): StartupTrailRow[] {
  return startup.steps.filter(isTrailStep).map((step) => {
    const tone = TONE_BY_STATE[step.state];
    const argument = stepArgument(step, setupCommand);
    const duration = stepDuration(startup.kind, step, now);
    const segments = [argument, duration].filter((part): part is string => part !== undefined);
    return {
      phase: step.phase,
      tone,
      label: startupStepLabel(startup.kind, step),
      // Paper sets a failed row's argument and duration as one "exit 1 · 0:14" run.
      meta: tone === "failed" && segments.length > 1 ? [segments.join(" · ")] : segments,
      title: step.detail?.phase === "worktree" ? step.detail.path : undefined,
      expandable: step.phase === "setup" && SETUP_OUTPUT_STATES.has(step.state),
    };
  });
}

/** What a screen reader hears when the trail changes state. It never includes a ticking duration. */
export function startupTrailAnnouncement(startup: Pick<ThreadStartup, "kind" | "state" | "steps"> | undefined): string {
  if (!startup) return "Preparing thread";
  if (startup.state === "completed") return "Thread started";
  const current = startup.steps.filter(isTrailStep).filter((step) => step.state !== "pending").at(-1);
  return current ? startupStepLabel(startup.kind, current) : "Preparing thread";
}

/** Pending rows drawn before the server returns the first startup record. */
export function placeholderTrailRows(kind: ThreadStartupKind): StartupTrailRow[] {
  return startupTrailRows({
    kind,
    steps: getThreadStartupPhases(kind).map((phase) => ({ phase, state: "pending" })),
  }, { now: 0 });
}

/** Collapses a completed startup to its total time, worktree folder and setup command. */
export function startupTrailSummary(
  startup: Pick<ThreadStartup, "steps" | "createdAt" | "updatedAt">,
  setupCommand: string | undefined,
): StartupTrailSummary {
  const agentEnd = startup.steps.find((step) => step.phase === "agent")?.endedAt;
  const duration = formatStartupDuration(Date.parse(agentEnd ?? startup.updatedAt) - Date.parse(startup.createdAt));
  const worktree = startup.steps.find((step) => step.phase === "worktree")?.detail;
  const setupRan = startup.steps.some((step) => step.phase === "setup" && step.state === "completed");
  const parts = [
    worktree?.phase === "worktree" ? worktree.folderName : undefined,
    setupRan ? setupCommand : undefined,
  ].filter((part): part is string => part !== undefined);
  return { duration, parts };
}

/** Whether any step is running, which is the only time trail durations tick. */
export function startupHasLiveStep(startup: Pick<ThreadStartup, "steps"> | undefined): boolean {
  return startup?.steps.some((step) => step.state === "running") ?? false;
}
