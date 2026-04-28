/**
 * Maps the legacy integer migration versions (1-20) to their corresponding
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
  [19, "00000000000020"],   // was renumbered to 020 to avoid branch collision
  [20, "00000000000020"],
]);
