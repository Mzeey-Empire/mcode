/** Startup steps trail shown under a thread's first message and in startup dialogs. */
export { StartupStepsTrail, type StartupStepsTrailProps } from "./StartupStepsTrail";
/** Setup recovery shortcuts shared by the trail's hosts. */
export { editStartupSetupScript, openStartupSetupTerminal } from "./useStartupActions";
/** Composer starting state and its startup cancel. */
export { useStartingThread } from "./useStartupActions";
/** Authoritative startup record state and recovery hook. */
export { useThreadStartup, useThreadStartupStore } from "./state/thread-startup-store";
