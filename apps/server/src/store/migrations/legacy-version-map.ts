/**
 * Maps the legacy integer migration versions to their corresponding
 * 14-character zero-padded string keys used by the timestamp-based scheme.
 *
 * This is consulted exactly once per database, the first time a database with
 * an INTEGER-typed `_migrations.version` column is opened after the timestamp
 * cutover. After that, the table is rewritten with TEXT keys and this map is
 * never read again.
 *
 * The mapping is intentionally hardcoded so that the upgrade is deterministic
 * and self-contained — adding new migrations after the cutover must use real
 * timestamps, not extend this map.
 *
 * Why both 19 and 20 are mapped:
 * - Integer 19 represents `workspace_sort_order` from the sibling
 *   feat/modern-project-selector branch. Databases that picked it up retain
 *   it as the gap-keyed "00000000000019", which has no migration module on
 *   this branch (the runner tolerates gaps; only `validate()` reports them).
 * - Integer 20 represents `thread_has_file_changes`. The original 019 file
 *   on this branch was renumbered to 020 to avoid colliding with the sibling
 *   branch's 019. A database where 020 was applied under the old integer
 *   runner needs this row to translate to "00000000000020" so the upgraded
 *   runner sees it as already applied and does not re-run it.
 *
 * Identity-preserving translations are the safe default: each integer maps
 * to the same numeric value as a 14-char string, so the upgrade neither
 * fabricates a fresh apply nor invents history.
 */
export const LEGACY_VERSION_MAP = new Map<number, string>([
  [1, "00000000000001"],
  [2, "00000000000002"],
  [3, "00000000000003"],
  [4, "00000000000004"],
  [5, "00000000000005"],
  [6, "00000000000006"],
  [7, "00000000000007"],
  [8, "00000000000008"],
  [9, "00000000000009"],
  [10, "00000000000010"],
  [11, "00000000000011"],
  [12, "00000000000012"],
  [13, "00000000000013"],
  [14, "00000000000014"],
  [15, "00000000000015"],
  [16, "00000000000016"],
  [17, "00000000000017"],
  [18, "00000000000018"],
  [19, "00000000000019"],
  [20, "00000000000020"],
]);
