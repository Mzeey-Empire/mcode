import type { IAgentProvider } from "@mcode/contracts/providers/interfaces";

/** Largest first-turn input Codex accepts inline, so seeded Codex prompts must fit inside it. */
export const CODEX_INLINE_INPUT_MAX_CHARS = 14_000;

/**
 * The most characters one turn may carry to the target. Codex also inlines its input into a prompt with a
 * tighter ceiling than the provider declares, so the smaller of the two bounds the handoff.
 */
export function targetInputCharacterCap(target: Pick<IAgentProvider, "id" | "maxInputCharactersPerTurn">): number {
  return target.id === "codex"
    ? Math.min(target.maxInputCharactersPerTurn, CODEX_INLINE_INPUT_MAX_CHARS)
    : target.maxInputCharactersPerTurn;
}
