import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Lucide icon names available for project actions. */
export const ACTION_ICONS = [
  "play",
  "square",
  "flask-conical",
  "download",
  "hammer",
  "zap",
  "terminal",
  "bug",
  "package",
  "rocket",
  "refresh-cw",
  "check",
  "code",
  "database",
  "globe",
  "shield",
] as const;

export const ActionIconSchema = z.enum(ACTION_ICONS);

/** Schema for a single project action. */
export const ActionSchema = lazySchema(() =>
  z.object({
    id: z.string().min(1).regex(/^[a-z0-9-]+$/, "Must be a URL-safe slug"),
    name: z.string().min(1).max(50),
    command: z.string().min(1),
    icon: ActionIconSchema,
    shortcut: z.string().optional(),
    setup: z.boolean().default(false),
  }),
);

export type Action = z.infer<ReturnType<typeof ActionSchema>>;
export type ActionIcon = z.infer<typeof ActionIconSchema>;

/** Schema for the actions JSON file. */
export const ActionsFileSchema = lazySchema(() =>
  z.object({
    actions: z.array(ActionSchema()),
  }),
);

export type ActionsFile = z.infer<ReturnType<typeof ActionsFileSchema>>;
