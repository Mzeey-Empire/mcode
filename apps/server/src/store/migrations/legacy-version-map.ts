/**
 * Maps the legacy integer migration versions (1-19) to their corresponding
 * 14-character zero-padded string keys used by the timestamp-based scheme.
 *
 * This is consulted exactly once per database, the first time a database with
 * an INTEGER-typed `_migrations.version` column is opened after the timestamp
 * cutover. After that, the table is rewritten with TEXT keys and this map is
 * never read again.
 *
 * The mapping is intentionally hardcoded so that the upgrade is deterministic
 * and self-contained — adding new migrations after version 20 must use real
 * timestamps, not extend this map.
 *
 * Note: integer version 19 maps to "00000000000020" because the original
 * 019_thread_has_file_changes.ts was renumbered to 020 before this
 * integer→timestamp migration landed, to avoid a collision with the
 * feat/modern-project-selector branch's own 019 migration. Integer version
 * 20 never existed in the integer scheme.
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
  [19, "00000000000020"],
]);
