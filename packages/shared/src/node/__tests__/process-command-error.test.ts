import { describe, expect, it } from "vitest";
import { ProcessCommandError } from "@mcode/shared/node/process-command-error";

describe("ProcessCommandError", () => {
  it.each(["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ABORT_ERR"])(
    "does not report %s as a timeout even when the child was signaled",
    (code) => {
      const cause = Object.assign(new Error("Command failed: powershell.exe"), {
        code,
        killed: true,
        signal: "SIGTERM",
      });

      expect(ProcessCommandError.fromExecFileError(cause).timedOut).toBe(false);
    },
  );
});
