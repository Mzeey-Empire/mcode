import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/**
 * Which data the running build touches: `dev` uses the checkout's `.dev` state, `nightly` and
 * `stable` use the shared `~/.mcode` and differ only by release line.
 */
export type BuildStage = "dev" | "nightly" | "stable";

/** Wire shape of a {@link BuildStage}, used as the `app.stage` RPC result. */
export const BuildStageSchema = lazySchema(() => z.enum(["dev", "nightly", "stable"]));

/** Nightly builds carry `-nightly.` in their version, for example `0.13.0-nightly.20260815.1`. */
export function isNightlyVersion(version: string): boolean {
  return version.includes("-nightly.");
}

/**
 * Classifies a running build. The dev launchers set `MCODE_AGENT_RUNTIME=1` and a dev build
 * reports the same version as stable, so the marker wins over the version.
 */
export function resolveBuildStage(input: { agentRuntime: boolean; version: string }): BuildStage {
  if (input.agentRuntime) return "dev";
  return isNightlyVersion(input.version) ? "nightly" : "stable";
}

/** The product name shown in titles and About surfaces. Stable builds carry no suffix. */
export function appDisplayName(stage: BuildStage): string {
  switch (stage) {
    case "dev":
      return "Mcode (Dev)";
    case "nightly":
      return "Mcode (Nightly)";
    case "stable":
      return "Mcode";
  }
}
