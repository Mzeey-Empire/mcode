import { describe, it, expect } from "vitest";
import { WS_METHODS } from "@mcode/contracts";

describe("agent.listRunning contract", () => {
  it("is registered in WS_METHODS with string[] result", () => {
    const methods = WS_METHODS();
    expect(methods).toHaveProperty("agent.listRunning");
    const result = methods["agent.listRunning"].result.safeParse(["t-1", "t-2"]);
    expect(result.success).toBe(true);
  });

  it("accepts empty params", () => {
    const methods = WS_METHODS();
    const parsed = methods["agent.listRunning"].params.safeParse({});
    expect(parsed.success).toBe(true);
  });
});
