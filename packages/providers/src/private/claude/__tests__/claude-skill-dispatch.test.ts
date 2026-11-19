import { describe, expect, it } from "vitest";
import { planClaudeSkillDispatch } from "../claude-skill-dispatch.js";

const skills = new Map([
  ["to-spec", { path: "/skills/to-spec/SKILL.md", userInvocationOnly: true }],
  ["to-tickets", { path: "/skills/to-tickets/SKILL.md", userInvocationOnly: true }],
  ["review", { path: "/skills/review/SKILL.md", userInvocationOnly: false }],
]);

describe("planClaudeSkillDispatch", () => {
  it("points Claude to the first user-only skill and dispatches the last one natively", () => {
    const prompt = "I think what shoudl be done first with example iagme references to how this shoudl work is /to-spec  and /to-tickets";

    expect(planClaudeSkillDispatch(prompt, skills)).toEqual({
      leadingText: "I think what shoudl be done first with example iagme references to how this shoudl work is /to-spec [The user invoked this skill. Follow the instructions at: /skills/to-spec/SKILL.md]  and /to-tickets",
      commandText: "/to-tickets",
      skillName: "to-tickets",
    });
  });

  it("preserves arguments when the only mention opens the prompt", () => {
    expect(planClaudeSkillDispatch("  /to-tickets for the spec  \n", skills)).toEqual({
      leadingText: undefined,
      commandText: "/to-tickets for the spec",
      skillName: "to-tickets",
    });
  });

  it("ignores paths, URLs, and unknown names", () => {
    const knownPrefixes = new Map(skills).set("usr", { path: "/skills/usr/SKILL.md", userInvocationOnly: true });

    expect(planClaudeSkillDispatch("Check /usr/bin and /unknown and https://example.test/to-spec", knownPrefixes)).toBeUndefined();
  });

  it("adds one note for a repeated earlier skill and none for the final skill", () => {
    expect(planClaudeSkillDispatch("/to-tickets then /to-spec then /to-spec then /to-tickets", skills)).toEqual({
      leadingText: "/to-tickets then /to-spec [The user invoked this skill. Follow the instructions at: /skills/to-spec/SKILL.md] then /to-spec then /to-tickets",
      commandText: "/to-tickets",
      skillName: "to-tickets",
    });
  });

  it("leaves an earlier model-invocable skill to Claude's Skill tool", () => {
    expect(planClaudeSkillDispatch("Use /review before /to-tickets for the spec  ", skills)).toEqual({
      leadingText: "Use /review before /to-tickets for the spec",
      commandText: "/to-tickets for the spec",
      skillName: "to-tickets",
    });
  });
});
