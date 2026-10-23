/** A migration that breaks older builds. After the floor migration it also raises the floor. */
export type ContractStep = Readonly<{
  /** Exactly the breaks `detectSchemaBreaks` finds in the migration; empty for a break the lint cannot see. */
  breaks: readonly string[];
  reason: string;
  /**
   * Tag of the newest migration that shipped in the release whose code no longer uses the removed
   * shape. Required after the floor migration: the step raises the floor to this migration's `when`,
   * so that release keeps opening the database and only older builds refuse. Optional before it,
   * where the seeded floor already covers the step.
   */
  expandedIn?: string;
}>;

/** A migration with statements beyond the additive allowlist that older builds nevertheless tolerate. */
export type CompatibleStep = Readonly<{ reason: string }>;

/**
 * The migration that created `mcode_schema_compatibility`. Floors are only enforced from here on:
 * it seeds the floor with the newest contract step that shipped before it.
 */
export const FLOOR_MIGRATION_TAG = "0092_rich_outlaw_kid";

/** The table the floor lives in. Only the floor migration and contract steps may write it. */
export const FLOOR_TABLE_NAME = "mcode_schema_compatibility";

/**
 * Reviewed schema breaks, keyed by migration tag. Each entry must list exactly the breaks the lint
 * detects for its tag. A contract step after the floor migration must also name `expandedIn` and
 * contain {@link floorUpsertStatement} for that migration's `when` and the step's own tag.
 */
export const CONTRACT_STEPS: Readonly<Record<string, ContractStep>> = {
  "0009_fancy_ben_urich": {
    breaks: ["drop-column messages.is_internal"],
    reason: "Only the 0009 snapshot lost the column; no SQL drops it, so databases still have messages.is_internal.",
  },
  "0068_tricky_morg": {
    breaks: ["drop-column threads.copilot_agent"],
    reason: "Drops the Copilot agent selection column; a build that still selects it fails on the missing column.",
  },
  "0071_last_anita_blake": {
    breaks: ["drop-column plans.change_summary", "drop-column plans.sections_json"],
    reason: "Rebuilds plans without the summary and sections columns that older builds read and write.",
  },
  "0074_closed_alex_power": {
    breaks: ["drop-table diff_summaries"],
    reason: "Drops the diff summaries table; a build that still queries it fails.",
  },
  "0089_moaning_iceman": {
    breaks: ["drop-column project_action_runs.transcript", "drop-column project_action_runs.transcript_truncated"],
    reason: "Drops the stored action transcript columns; older builds insert and select them.",
  },
  "0091_happy_baron_strucker": {
    breaks: [
      "drop-column workspace_environment_automatic_setup_attempts.exit_code",
      "drop-column workspace_environment_automatic_setup_attempts.launch_snapshot_json",
      "drop-column workspace_environment_automatic_setup_attempts.outcome",
      "drop-column workspace_environment_automatic_setup_attempts.output",
      "drop-column workspace_environment_automatic_setup_attempts.output_truncated",
    ],
    reason: "Drops the automatic setup attempt result columns; older builds record and read them. The floor migration seeds the floor with this step.",
  },
};

/** Migrations after the floor migration that are not auto-additive but do not break older builds. */
export const COMPATIBLE_STEPS: Readonly<Record<string, CompatibleStep>> = {
  "0098_workable_cardiac": {
    reason: "Adds nullable threads.fast_mode, backfills it from codex_fast_mode, and adds triggers that copy codex_fast_mode writes into fast_mode. Older builds keep reading and writing codex_fast_mode, which newer builds still write, and the triggers keep fast_mode current after an older build writes. Drop both triggers before dropping codex_fast_mode.",
  },
  "0097_parallel_madelyne_pryor": {
    reason: "Adds nullable delegated_tasks.notice_delivered and notice_claim, and backfills notice_delivered so tasks that finished before the upgrade do not wake their Coordinator. Older builds never read or write either column.",
  },
  "0095_worried_anthem": {
    reason: "The unique retry key belongs only to the new delegated_tasks table. Older builds never insert into that table, so their writes are unchanged.",
  },
  "0094_bumpy_triathlon": {
    reason: "Creates thread_provider_sessions and backfills it from threads.sdk_session_id with INSERT OR IGNORE. Older builds never read or write the new table and keep using the unchanged threads columns.",
  },
};

/**
 * The statement that raises the floor to `when`, recording the contract step `tag` that raised it.
 * A contract step passes the `when` of its `expandedIn` migration, not its own. The floor never
 * goes down, so replaying it or running migrations out of order cannot lower it. Hand-add it to the
 * end of every contract step's SQL after generating the migration.
 */
export function floorUpsertStatement(when: number, tag: string): string {
  return `INSERT INTO \`${FLOOR_TABLE_NAME}\` (\`id\`, \`floor_when\`, \`raised_by\`) VALUES (1, ${when}, '${tag}') `
    + "ON CONFLICT(`id`) DO UPDATE SET `floor_when` = max(`floor_when`, excluded.`floor_when`), "
    + "`raised_by` = CASE WHEN excluded.`floor_when` > `floor_when` THEN excluded.`raised_by` ELSE `raised_by` END;";
}
