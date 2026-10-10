/** Startup steps trail shown under a thread's first message and in startup dialogs. */
export { StartupStepsTrail, type StartupStepsTrailProps } from "./StartupStepsTrail";
/** Setup recovery shortcuts shared by the trail's hosts. */
export { editStartupSetupScript, openStartupSetupTerminal } from "./useStartupActions";
/** Authoritative startup record state and recovery hook. */
export { useThreadStartup, useThreadStartupStore } from "./state/thread-startup-store";
/** The 04g first-send motion: the start column records, the docked surface and the sidebar play. */
export { recordFirstSend, useFirstSendMotion, usePreparingRowEntrance } from "./first-send-motion";
