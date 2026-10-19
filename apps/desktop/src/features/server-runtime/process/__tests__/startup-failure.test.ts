import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STARTUP_FAILURE_FILE_MAX_BYTES, STARTUP_FAILURE_FILE_NAME, type StartupRefusal } from "@mcode/contracts";
import { readStartupRefusal } from "../startup-failure.js";

const STARTUP_ID = "00000000-0000-4000-8000-0000000000bb";

describe("readStartupRefusal", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-desktop-startup-failure-"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  });

  function writeRefusal(detail: string): StartupRefusal {
    const refusal: StartupRefusal = { kind: "database-unreadable", databasePath: "/tmp/mcode/mcode.db", detail };
    NodeFS.writeFileSync(
      NodePath.join(dataDir, STARTUP_FAILURE_FILE_NAME),
      JSON.stringify({ version: 1, startupId: STARTUP_ID, refusal }),
    );
    return refusal;
  }

  it("returns the refusal recorded for this spawn", () => {
    const refusal = writeRefusal("disk image is malformed");

    expect(readStartupRefusal(dataDir, STARTUP_ID)).toEqual(refusal);
  });

  it("returns null when the server left no file", () => {
    expect(readStartupRefusal(dataDir, STARTUP_ID)).toBeNull();
  });

  it("measures the limit in bytes, so a file of two-byte characters over the limit is ignored", () => {
    const twoByteCharacters = "é".repeat(STARTUP_FAILURE_FILE_MAX_BYTES * 0.6);
    writeRefusal(twoByteCharacters);
    const file = NodePath.join(dataDir, STARTUP_FAILURE_FILE_NAME);
    expect(NodeFS.statSync(file).size).toBeGreaterThan(STARTUP_FAILURE_FILE_MAX_BYTES);
    expect(NodeFS.readFileSync(file, "utf-8").length).toBeLessThan(STARTUP_FAILURE_FILE_MAX_BYTES);

    expect(readStartupRefusal(dataDir, STARTUP_ID)).toBeNull();
  });
});
