/**
 * Maps the unambiguous legacy integer migration versions (1-18) to their
 * corresponding 14-character zero-padded string keys used by the timestamp-
 * based scheme.
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
 * Integers 19 and 20 are *not* listed here because they are ambiguous across
 * sibling branches (this branch had `thread_has_file_changes` at v19, then
 * v20 after a rename; main's lineage has `workspace_pinned_and_last_opened`
 * at v20; another branch had `workspace_sort_order` at v19). The runner
 * resolves them by sniffing the live schema — see
 * `MigrationRunner.translateLegacyVersion`.
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
]);
