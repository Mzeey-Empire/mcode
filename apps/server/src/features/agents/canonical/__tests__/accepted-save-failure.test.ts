import { describe, expect, it } from "vitest";
import { DatabaseWriterAdmissionFull } from "../../../../runtime/persistence/sqlite/application-database-writer.js";
import { AcceptedContentRejected, classifySaveFailure } from "../accepted-save-failure.js";

const sqlite = (code: string) => Object.assign(new Error(code), { code });

describe("classifySaveFailure", () => {
  it.each([
    ["a full disk", sqlite("SQLITE_FULL"), "environment"],
    ["an unknown error", new Error("Accepted stream durable predecessor does not match"), "environment"],
    ["a busy database inside a wrapper", new Error("Failed to run the query", { cause: sqlite("SQLITE_BUSY") }), "transient"],
    ["writer backpressure", new DatabaseWriterAdmissionFull("Database writer admission is full"), "transient"],
    // A failure crossing the execution worker is rebuilt as a plain Error that keeps only name, message and code.
    ["writer backpressure rebuilt by a worker", sqlite(new DatabaseWriterAdmissionFull("x").code), "transient"],
    ["a content rejection inside a wrapper", new Error("Canonical writer write-failed", { cause: new AcceptedContentRejected("too large") }), "content"],
  ])("classifies %s", (_name, error, expected) => {
    expect(classifySaveFailure(error)).toBe(expected);
  });
});
