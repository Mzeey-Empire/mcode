/**
 * Converts persisted grace-period seconds into milliseconds using mode-aware defaults.
 *
 * When the value is still the schema default (30s), dev uses a shorter wait so local
 * workflows can cycle servers quickly; production keeps the full 30s default unless
 * the user overrides it.
 */
export function resolveGracePeriodMs(
  settingSeconds: number,
  isProduction: boolean,
): number {
  const devDefaultSeconds = 5;
  const schemaDefaultSeconds = 30;

  const seconds =
    settingSeconds !== schemaDefaultSeconds
      ? settingSeconds
      : isProduction
        ? schemaDefaultSeconds
        : devDefaultSeconds;

  return seconds * 1000;
}
