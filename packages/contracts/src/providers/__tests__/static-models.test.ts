import { describe, expect, it } from "vitest";
import { CLAUDE_STATIC_MODELS } from "../claude-static-fallback.js";
import { CODEX_STATIC_MODELS } from "../codex-static-fallback.js";
import { ProviderModelInfoSchema } from "../models.js";

describe("static provider catalogs", () => {
  it.each([...CLAUDE_STATIC_MODELS, ...CODEX_STATIC_MODELS].map((row) => [row.id, row] as const))(
    "%s parses as ProviderModelInfo",
    (_id, row) => {
      expect(ProviderModelInfoSchema().parse(row)).toEqual(row);
    },
  );
});
