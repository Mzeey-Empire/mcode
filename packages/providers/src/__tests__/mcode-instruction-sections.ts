import { expect } from "vitest";
import { buildMcodeInstructionSections, type McodeAttachedToolkits } from "@mcode/thread-orchestration";

const ALL_MCODE_TOOLKITS: McodeAttachedToolkits = { browser: true, threadControl: true, visuals: true };

/**
 * Asserts that `prompt` carries the Mcode instruction sections selected for `toolkits` and no section
 * selected only by another toolkit, without restating the wording `@mcode/thread-orchestration` owns.
 */
export function expectInstructionSections(prompt: string, toolkits: McodeAttachedToolkits): void {
  const expected = buildMcodeInstructionSections({ toolkits });
  for (const section of expected) {
    expect(prompt).toContain(section.text);
  }
  for (const section of buildMcodeInstructionSections({ toolkits: ALL_MCODE_TOOLKITS })) {
    if (!expected.some(({ key }) => key === section.key)) {
      expect(prompt).not.toContain(section.text);
    }
  }
}
