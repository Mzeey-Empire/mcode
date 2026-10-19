import "reflect-metadata";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";
import { StartupFailureFileSchema } from "@mcode/contracts";
import { logger } from "@mcode/shared";
import { setupContainer } from "../../composition/container.js";
import { ApplicationDatabaseWriter } from "../../../runtime/persistence/sqlite/application-database-writer.js";
import { DatabaseStartupRefusal } from "../../../runtime/persistence/sqlite/startup-refusal.js";
import { runStartupOrExit, startupFailurePath } from "../startup-failure.js";

const STARTUP_ID = "00000000-0000-4000-8000-0000000000aa";

class ExitCalled extends Error {
  override readonly name = "ExitCalled";

  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function fakeExit(code: number): never {
  throw new ExitCalled(code);
}

function readFailureFile(dataDir: string): unknown {
  return JSON.parse(NodeFS.readFileSync(startupFailurePath(dataDir), "utf8"));
}

describe("runStartupOrExit", () => {
  let dataDir: string;
  let databasePath: string;
  const previousDatabasePath = process.env.MCODE_DB_PATH;

  beforeEach(() => {
    container.reset();
    dataDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mcode-startup-failure-"));
    databasePath = NodePath.join(dataDir, "mcode.db");
    process.env.MCODE_DB_PATH = databasePath;
  });

  afterEach(async () => {
    if (container.isRegistered(ApplicationDatabaseWriter)) await container.resolve(ApplicationDatabaseWriter).close();
    container.reset();
    if (previousDatabasePath === undefined) delete process.env.MCODE_DB_PATH;
    else process.env.MCODE_DB_PATH = previousDatabasePath;
    NodeFS.rmSync(dataDir, { recursive: true, force: true });
  });

  it("records the refusal for a damaged database and exits 78", async () => {
    NodeFS.writeFileSync(databasePath, "this is not a sqlite database".repeat(100));

    const outcome = await runStartupOrExit(() => setupContainer(dataDir), { dataDir, startupId: STARTUP_ID, exit: fakeExit }).catch(
      (error: unknown) => error,
    );

    expect(outcome).toMatchObject({ name: "ExitCalled", code: 78 });
    const file = StartupFailureFileSchema().parse(readFailureFile(dataDir));
    expect(file.startupId).toBe(STARTUP_ID);
    expect("refusal" in file && file.refusal.kind).toBe("database-unreadable");
    expect("refusal" in file && file.refusal.databasePath).toBe(databasePath);
    expect(NodeFS.readdirSync(dataDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("records a refusal thrown directly, without a wrapper", async () => {
    const refusal = { kind: "database-busy", databasePath } as const;

    await expect(
      runStartupOrExit(() => Promise.reject(new DatabaseStartupRefusal(refusal)), { dataDir, startupId: STARTUP_ID, exit: fakeExit }),
    ).rejects.toBeInstanceOf(ExitCalled);

    expect(StartupFailureFileSchema().parse(readFailureFile(dataDir))).toEqual({ version: 1, startupId: STARTUP_ID, refusal });
  });

  it("records an unexpected failure as unexpected, not as a refusal", async () => {
    const exit = vi.fn(fakeExit);

    await expect(
      runStartupOrExit(() => Promise.reject(new Error("container wiring broke")), { dataDir, startupId: STARTUP_ID, exit }),
    ).rejects.toBeInstanceOf(ExitCalled);

    expect(exit).toHaveBeenCalledWith(78);
    const file = StartupFailureFileSchema().parse(readFailureFile(dataDir));
    expect(file).toEqual({ version: 1, startupId: STARTUP_ID, unexpected: { message: "container wiring broke" } });
  });

  it("logs the stack of an unexpected failure, and only the message of a refusal", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => logger);
    try {
      await runStartupOrExit(() => Promise.reject(new Error("container wiring broke")), { dataDir, startupId: STARTUP_ID, exit: fakeExit }).catch(
        () => undefined,
      );
      await runStartupOrExit(() => Promise.reject(new DatabaseStartupRefusal({ kind: "database-busy", databasePath })), {
        dataDir,
        startupId: STARTUP_ID,
        exit: fakeExit,
      }).catch(() => undefined);

      const [unexpected, refusal] = error.mock.calls.map(([, fields]) => fields);
      expect(unexpected).toMatchObject({ kind: "unexpected", stack: expect.stringContaining("startup-failure.test") });
      expect(refusal).toMatchObject({ kind: "database-busy" });
      expect(refusal).not.toHaveProperty("stack");
    } finally {
      error.mockRestore();
    }
  });

  it("leaves a record from an earlier start alone when this start succeeds", async () => {
    const earlier = JSON.stringify({ version: 1, startupId: "someone-elses", unexpected: { message: "earlier" } });
    NodeFS.writeFileSync(startupFailurePath(dataDir), earlier);

    await expect(runStartupOrExit(() => Promise.resolve("up"), { dataDir, startupId: STARTUP_ID, exit: fakeExit })).resolves.toBe("up");

    expect(NodeFS.readFileSync(startupFailurePath(dataDir), "utf8")).toBe(earlier);
  });

  it("rethrows without writing a file or exiting when the desktop gave no startup id", async () => {
    const exit = vi.fn(fakeExit);
    const failure = new Error("dev start failed");

    await expect(runStartupOrExit(() => Promise.reject(failure), { dataDir, startupId: undefined, exit })).rejects.toBe(failure);

    expect(exit).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(startupFailurePath(dataDir))).toBe(false);
  });
});
