import { describe, expect, it } from "vitest";
import { TurnAdmissionError, turnAdmissionFailureReason } from "../turn-admission-error.js";

function codedError(code: string, data?: unknown): Error {
  return Object.assign(new Error("Thread thread-1 already has an active agent session"), { code, data });
}

describe("turnAdmissionFailureReason", () => {
  it("reads the reason a local refusal carries", () => {
    expect(turnAdmissionFailureReason(new TurnAdmissionError("pending_mutation", "any text"))).toBe("pending_mutation");
  });

  it("reads a remote refusal from its code and data", () => {
    expect(turnAdmissionFailureReason(codedError("TURN_ADMISSION_REJECTED", { reason: "stopped" }))).toBe("stopped");
  });

  it("does not classify an error by its busy message text", () => {
    expect(turnAdmissionFailureReason(new Error("Thread thread-1 already has an active agent session"))).toBeNull();
  });

  it("returns null for an unknown code", () => {
    expect(turnAdmissionFailureReason(codedError("INTERNAL_ERROR", { reason: "busy" }))).toBeNull();
  });

  it.each([
    ["an unknown reason", { reason: "sleepy" }],
    ["extra fields", { reason: "busy", extra: true }],
    ["missing data", undefined],
  ])("returns null for a refusal with %s", (_label, data) => {
    expect(turnAdmissionFailureReason(codedError("TURN_ADMISSION_REJECTED", data))).toBeNull();
  });

  it.each(["PROVIDER_DISABLED", "PROVIDER_CLI_MISSING"])("reads %s as unavailable", (code) => {
    expect(turnAdmissionFailureReason(codedError(code))).toBe("unavailable");
  });
});
