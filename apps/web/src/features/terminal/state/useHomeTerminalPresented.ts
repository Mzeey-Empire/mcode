import { HOME_TERMINAL_SCOPE_ID } from "@mcode/contracts";
import { useTerminalStore } from "./terminalStore";

/**
 * True while the home scope holds any terminal record.
 */
export function useHomeTerminalPresented(): boolean {
  return useTerminalStore((state) => (state.terminals[HOME_TERMINAL_SCOPE_ID]?.length ?? 0) > 0);
}
