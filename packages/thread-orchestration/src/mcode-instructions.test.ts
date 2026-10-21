import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildMcodeInstructionSections, isExplicitMcodeThreadRequest, MCODE_INSTRUCTION_SECTION_MAX_BYTES } from "./mcode-instructions.js";

describe("thread launch requests", () => {
  it("recognizes a request naming thread_launch", () => {
    expect(isExplicitMcodeThreadRequest("Use thread_launch to start a separate conversation")).toBe(true);
  });

  it("rejects a negated thread_launch request", () => {
    expect(isExplicitMcodeThreadRequest("Don't use thread_launch")).toBe(false);
  });

  it("keeps launch guidance within the provider context budget", () => {
    const sections = buildMcodeInstructionSections({ toolkits: { threadControl: true, browser: false } });
    for (const section of sections) {
      expect(NodeBuffer.Buffer.byteLength(section.text, "utf8")).toBeLessThanOrEqual(MCODE_INSTRUCTION_SECTION_MAX_BYTES);
    }
  });
});
