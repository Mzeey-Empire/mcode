import type { ReviewState, ReviewTurn } from "@mcode/contracts/models/review-comparison";
import type { TurnSnapshot } from "@mcode/contracts/models/turn-snapshot";
import type { PanelScope } from "@/lib/panel-tabs";
import type { DiffViewMode } from "@/stores/diffStore";

/**
 * The kind of picked operand a comparison view shows on the left of header
 * row 2. `"branch"` picks a base and target ref pair, `"commit"` picks one
 * commit, and `"turn"` follows the latest turn or pins one. Views without an
 * operand (Since you looked, Unstaged, Staged, All turns) are fixed comparisons. See
 * CONTEXT.md, "Comparison".
 */
export type ReviewViewOperand = "branch" | "commit" | "turn";

/** Static metadata for one Review view. Pure data, with no store or React state. */
export interface ReviewView {
  /** Stable id; maps 1:1 onto the store's {@link DiffViewMode}. */
  readonly id: DiffViewMode;
  /** The name the view menu and row 1 show. */
  readonly label: string;
  /** The picked operand row 2 shows for this view, if any. */
  readonly operand?: ReviewViewOperand;
}

const REVIEW_VIEW_BY_ID: Readonly<Record<DiffViewMode, ReviewView>> = {
  turn: { id: "turn", label: "Turn", operand: "turn" },
  "since-looked": { id: "since-looked", label: "Since you looked" },
  cumulative: { id: "cumulative", label: "All turns" },
  unstaged: { id: "unstaged", label: "Unstaged" },
  staged: { id: "staged", label: "Staged" },
  commit: { id: "commit", label: "Commit", operand: "commit" },
  branch: { id: "branch", label: "Branch", operand: "branch" },
};

/**
 * The view menu's groups, in menu order, with a divider between groups (Paper
 * board 10b). Every view stays listed in every scope; one that cannot load is
 * dimmed with its reason from {@link reviewViewAvailability}.
 */
export const REVIEW_VIEW_GROUPS: readonly (readonly ReviewView[])[] = [
  [REVIEW_VIEW_BY_ID.turn, REVIEW_VIEW_BY_ID["since-looked"], REVIEW_VIEW_BY_ID.cumulative],
  [REVIEW_VIEW_BY_ID.unstaged, REVIEW_VIEW_BY_ID.staged],
  [REVIEW_VIEW_BY_ID.commit, REVIEW_VIEW_BY_ID.branch],
];

/** Every Review view in menu order. Each view renders exactly one diff. */
export const REVIEW_VIEWS: readonly ReviewView[] = REVIEW_VIEW_GROUPS.flat();

/** The catalog entry for a view id. */
export function reviewViewById(id: DiffViewMode): ReviewView {
  return REVIEW_VIEW_BY_ID[id];
}

/** Whether one view can load now, and the tooltip reason when it cannot. */
export type ReviewViewAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** Availability for every Review view. */
export type ReviewViewAvailabilityMap = Readonly<Record<DiffViewMode, ReviewViewAvailability>>;

const AVAILABLE: ReviewViewAvailability = { available: true };
const THREADLESS_REASON = "Open a thread to review its turns";
const NOTHING_NEW_REASON = "Nothing new since you looked";

function unavailable(reason: string): ReviewViewAvailability {
  return { available: false, reason };
}

/**
 * Whether each Review view can load, with the reason a dimmed menu row shows.
 * `reviewState` and `turns` are null while unknown (still probing, or the
 * probe failed); an unknown input never dims a view, so a slow probe cannot
 * push the user off the view they picked. The view's own body reports a
 * failure once it loads. `sinceLooked` carries this visit's seen baseline and
 * the thread's snapshots, which are undefined while unknown.
 */
export function reviewViewAvailability(
  scope: PanelScope,
  reviewState: ReviewState | null,
  turns: readonly ReviewTurn[] | null,
  sinceLooked: SinceLookedInput = { baseline: null, snapshots: undefined },
): ReviewViewAvailabilityMap {
  const turnAvailability = turnViewAvailability(scope, turns);
  return {
    turn: turnAvailability,
    "since-looked": sinceLookedAvailability(scope, sinceLooked),
    cumulative: turnAvailability,
    unstaged: gitViewAvailability(reviewState, () => AVAILABLE),
    staged: gitViewAvailability(reviewState, (state) =>
      state.uncommitted.staged === 0 ? unavailable("Nothing staged") : AVAILABLE),
    commit: gitViewAvailability(reviewState, commitAvailability),
    branch: gitViewAvailability(reviewState, branchAvailability),
  };
}

type GitReviewState = Extract<ReviewState, { isGitRepo: true }>;

/** What Since you looked's availability reads: the visit's seen baseline and the thread's snapshot rows. */
export interface SinceLookedInput {
  /** This visit's seen baseline, or null when the visit has none. */
  readonly baseline: number | null;
  readonly snapshots: readonly TurnSnapshot[] | undefined;
}

/**
 * Message ids of the snapshot rows that put a turn in Since you looked: settled
 * after the baseline and with changes. An attempt count above 1 counts as
 * changes because an earlier attempt of that turn changed files even when the
 * latest one changed none. The server selects the whole turns for the diff.
 */
export function sinceLookedMessageIds(snapshots: readonly TurnSnapshot[], baseline: number): string[] {
  return snapshots
    .filter((row) => row.message_sequence > baseline && (row.files_changed.length > 0 || row.attempt_count > 1))
    .map((row) => row.message_id);
}

/**
 * Row 2's plain-text name for the turns Since you looked covers: "Turn 5" or
 * "Turns 3–5". Null when none of the message ids names a listed turn.
 */
export function sinceLookedTurnsLabel(turns: readonly ReviewTurn[], messageIds: readonly string[]): string | null {
  const ids = new Set(messageIds);
  const ordinals = turns.filter((turn) => ids.has(turn.messageId)).map((turn) => turn.ordinal);
  if (ordinals.length === 0) return null;
  const first = Math.min(...ordinals);
  const last = Math.max(...ordinals);
  return first === last ? `Turn ${first}` : `Turns ${first}–${last}`;
}

function sinceLookedAvailability(scope: PanelScope, { baseline, snapshots }: SinceLookedInput): ReviewViewAvailability {
  if (scope === "threadless") return unavailable(THREADLESS_REASON);
  if (baseline === null) return unavailable(NOTHING_NEW_REASON);
  if (snapshots === undefined) return AVAILABLE;
  return sinceLookedMessageIds(snapshots, baseline).length > 0 ? AVAILABLE : unavailable(NOTHING_NEW_REASON);
}

function turnViewAvailability(scope: PanelScope, turns: readonly ReviewTurn[] | null): ReviewViewAvailability {
  if (scope === "threadless") return unavailable(THREADLESS_REASON);
  if (turns !== null && turns.length === 0) return unavailable("No turns yet");
  return AVAILABLE;
}

function gitViewAvailability(
  reviewState: ReviewState | null,
  forRepository: (state: GitReviewState) => ReviewViewAvailability,
): ReviewViewAvailability {
  if (reviewState === null) return AVAILABLE;
  if (!reviewState.isGitRepo) return unavailable("Not a git repository");
  return forRepository(reviewState);
}

function commitAvailability(state: GitReviewState): ReviewViewAvailability {
  // Without a base there is no range of commits ahead to pick from, which is
  // the same gap the Branch view reports.
  if (state.commitsAhead === null) return unavailable("No branch to compare against");
  if (state.commitsAhead.count === 0) return unavailable(`No commits ahead of ${state.commitsAhead.base}`);
  return AVAILABLE;
}

function branchAvailability(state: GitReviewState): ReviewViewAvailability {
  if ("compare" in state.branchDefault) return AVAILABLE;
  return state.branchDefault.unavailable === "unborn"
    ? unavailable("No commits yet")
    : unavailable("No branch to compare against");
}

/**
 * The thread change-state inputs that pick a thread's default Review view, per
 * ADR-0011: turn changes from the loaded turn snapshots and working-tree
 * dirtiness from the review state probe.
 */
export interface ReviewChangeState {
  /** The thread has at least one turn snapshot with changed files. */
  readonly hasTurnChanges: boolean;
  /** The checkout has uncommitted changes. */
  readonly isDirty: boolean;
}

/**
 * The default Review view (ADR-0011). Turn changes open Turn, which follows
 * the latest turn. Otherwise a dirty checkout opens Unstaged, because Branch's
 * committed-only range would hide manual edits. A clean checkout opens Branch
 * when it can load, else Unstaged. Threadless scope has no turns, so it lands on
 * Unstaged. An unavailable pick falls through to the first available view in
 * menu order, and only a scope where nothing can load (no turns and no git)
 * returns Unstaged regardless. Since you looked is never a default: it is a
 * view the user asks for, and it would otherwise outrank All turns in menu order.
 */
export function defaultReviewView(
  scope: PanelScope,
  changeState: ReviewChangeState,
  availability: ReviewViewAvailabilityMap,
): DiffViewMode {
  const preferred: readonly DiffViewMode[] = [
    ...(scope === "thread" && changeState.hasTurnChanges ? (["turn"] as const) : []),
    ...(changeState.isDirty ? (["unstaged"] as const) : []),
    "branch",
    "unstaged",
    ...REVIEW_VIEWS.flatMap((view) => (view.id === "since-looked" ? [] : [view.id])),
  ];
  return preferred.find((id) => availability[id].available) ?? "unstaged";
}
