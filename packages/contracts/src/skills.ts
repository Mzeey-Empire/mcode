import { z } from "zod";
import { lazySchema } from "./utils/lazySchema.js";

/** Whether the entry comes from a Claude `skills/` dir or a `commands/` dir. */
export const SkillKindSchema = z.enum(["skill", "command"]);
export type SkillKind = z.infer<typeof SkillKindSchema>;

/** Where the entry was discovered. Used for grouping in the picker. */
export const SkillSourceSchema = z.enum(["user", "project", "agent", "plugin"]);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

/** Metadata for a discovered skill or command. */
export const SkillInfoSchema = lazySchema(() =>
  z.object({
    name: z.string(),
    description: z.string(),
    kind: SkillKindSchema.default("skill"),
    source: SkillSourceSchema.default("plugin"),
  }),
);
export type SkillInfo = z.infer<ReturnType<typeof SkillInfoSchema>>;

/** Per-path diagnostics returned by `skill.diagnose`. */
export const SkillDiagnosticsSchema = lazySchema(() =>
  z.object({
    scanned: z.array(
      z.object({
        path: z.string(),
        existed: z.boolean(),
        entries: z.number(),
      }),
    ),
    errors: z.array(z.object({ path: z.string(), message: z.string() })),
    totalSkills: z.number(),
    totalCommands: z.number(),
  }),
);
export type SkillDiagnostics = z.infer<ReturnType<typeof SkillDiagnosticsSchema>>;
