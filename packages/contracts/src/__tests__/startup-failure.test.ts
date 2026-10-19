import { describe, expect, it } from "vitest";
import { StartupFailureFileSchema, StartupRefusalSchema, describeRefusal, type StartupRefusal } from "../startup-failure.js";

const startupId = "00000000-0000-4000-8000-000000000002";
const databasePath = "/data/mcode.db";

const refusals: StartupRefusal[] = [
  { kind: "database-newer", databasePath, raisedBy: "0093_next" },
  { kind: "database-newer", databasePath, raisedBy: null },
  { kind: "database-busy", databasePath },
  { kind: "database-unreadable", databasePath, detail: "file is not a database" },
  { kind: "database-unknown-history", databasePath, detail: "No receipts." },
  { kind: "migration-mismatch", databasePath, tag: "0042_example" },
  { kind: "ledger-damaged", databasePath, tags: ["0042_example", "0043_example"] },
  { kind: "migration-failed", databasePath, sqliteMessage: "disk full", backupPath: "/data/mcode.db.bak-1" },
  { kind: "migration-failed", databasePath, sqliteMessage: "disk full", backupPath: null },
];

describe("StartupFailureFileSchema", () => {
  it.each(refusals)("round-trips a $kind refusal", (refusal) => {
    const file = { version: 1, startupId, refusal };
    expect(StartupFailureFileSchema().parse(file)).toEqual(file);
  });

  it("accepts an unexpected failure", () => {
    const file = { version: 1, startupId, unexpected: { message: "boom" } };
    expect(StartupFailureFileSchema().parse(file)).toEqual(file);
  });

  it.each([
    { name: "a future version", file: { version: 2, startupId, unexpected: { message: "boom" } } },
    { name: "no startupId", file: { version: 1, unexpected: { message: "boom" } } },
    { name: "an empty startupId", file: { version: 1, startupId: "", unexpected: { message: "boom" } } },
    { name: "neither refusal nor unexpected", file: { version: 1, startupId } },
    { name: "an unknown refusal kind", file: { version: 1, startupId, refusal: { kind: "disk-on-fire", databasePath } } },
    { name: "a refusal missing its data", file: { version: 1, startupId, refusal: { kind: "ledger-damaged", databasePath } } },
  ])("rejects $name", ({ file }) => {
    expect(StartupFailureFileSchema().safeParse(file).success).toBe(false);
  });
});

describe("describeRefusal", () => {
  it.each(refusals)("names the database path for a $kind refusal", (refusal) => {
    expect(StartupRefusalSchema().parse(refusal)).toEqual(refusal);
    expect(describeRefusal(refusal)).toContain(databasePath);
  });
});
