import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Longest workspace-relative icon path accepted on the wire and in storage. */
export const PROJECT_ICON_PATH_MAX_CHARS = 1_024;
/** Most workspaces one `workspace.icon.resolve` call may ask about. */
export const PROJECT_ICON_RESOLVE_MAX_IDS = 256;

/**
 * The icon a project shows: a chosen file, a detected favicon, or the monogram.
 * `chosenMissing` reports that the stored choice no longer resolves, so it can
 * only be true when the shown icon came from somewhere else.
 */
export const ProjectIconSchema = lazySchema(() => {
  const image = {
    workspaceId: z.string(),
    path: z.string().max(PROJECT_ICON_PATH_MAX_CHARS),
    version: z.string().max(64),
    /** Server-relative image route URL; changes whenever `version` changes. */
    url: z.string(),
  };
  return z.discriminatedUnion("source", [
    z.object({ ...image, source: z.literal("chosen"), chosenMissing: z.literal(false) }).strict(),
    z.object({ ...image, source: z.literal("automatic"), chosenMissing: z.boolean() }).strict(),
    z.object({ workspaceId: z.string(), source: z.literal("none"), chosenMissing: z.boolean() }).strict(),
  ]);
});
/** Resolved project icon for one workspace. */
export type ProjectIcon = z.infer<ReturnType<typeof ProjectIconSchema>>;
