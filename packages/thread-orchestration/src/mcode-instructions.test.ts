import * as NodeBuffer from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildMcodeInstructionSections, MCODE_INSTRUCTION_SECTION_MAX_BYTES } from "./mcode-instructions.js";

describe("thread launch requests", () => {
  it("keeps launch guidance within the provider context budget", () => {
    const sections = buildMcodeInstructionSections({ toolkits: { threadControl: true, browser: false, visuals: true } });
    for (const section of sections) {
      expect(NodeBuffer.Buffer.byteLength(section.text, "utf8")).toBeLessThanOrEqual(MCODE_INSTRUCTION_SECTION_MAX_BYTES);
    }
  });
});
