/** Electron GPU mode chosen once at launch, before app.whenReady(). */
export type HardwareAccelerationMode = "disabled" | "default";

/**
 * Select the launch acceleration mode. The frontend performance runner's
 * environment wins; otherwise the saved setting decides, and an unreadable
 * setting (null) keeps the product default of disabled.
 */
export function resolveHardwareAccelerationMode(
  env: Readonly<Record<string, string | undefined>>,
  savedHardwareAcceleration: boolean | null,
): HardwareAccelerationMode {
  if (env.MCODE_FRONTEND_PERFORMANCE_MODE !== "production") {
    return savedHardwareAcceleration === true ? "default" : "disabled";
  }
  const requested = env.MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE ?? "disabled";
  if (requested !== "disabled" && requested !== "default") {
    throw new Error(
      "MCODE_FRONTEND_PERFORMANCE_ACCELERATION_MODE must be disabled or default",
    );
  }
  return requested;
}
