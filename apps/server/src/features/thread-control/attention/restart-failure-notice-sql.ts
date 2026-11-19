import { PLANNED_RESTART_FAILURE_TEXTS, PLANNED_RESTART_NOTICE_KEY_PREFIX } from "@mcode/shared/planned-restart";

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * SQL condition matching a planned-restart failure notice on the `messages` alias, with the same rule as
 * `isPlannedRestartFailure`: the key prefix and exact failure text. Both values are shared constants, not input.
 */
export function restartFailureNoticeSql(alias: string): string {
  const texts = PLANNED_RESTART_FAILURE_TEXTS.map(sqlText).join(", ");
  return `${alias}.role = 'system' AND ${alias}.is_internal = 0 AND ${alias}.content IN (${texts})
    AND substr(json_extract(${alias}.system_notice, '$.noticeKey'), 1, ${PLANNED_RESTART_NOTICE_KEY_PREFIX.length}) = ${sqlText(PLANNED_RESTART_NOTICE_KEY_PREFIX)}`;
}
