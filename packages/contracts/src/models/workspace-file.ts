import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Maximum number of paths returned by file.list. */
export const FILE_LIST_MAX_PATHS = 100_000;
/** Maximum text payload displayed by the file viewer. */
export const FILE_VIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;
/** Caller-specific limits for the shared workspace image route. */
export const WORKSPACE_IMAGE_MAX_BYTES = { file: 20 * 1024 * 1024, icon: 2 * 1024 * 1024 } as const;
/** Maximum number of file change marks returned in one response. */
export const FILE_CHANGES_MAX_ENTRIES = 5_000;

/** Bounded workspace-relative file listing. */
export const WorkspaceFileListSchema = lazySchema(() => z.object({
  paths: z.array(z.string()).max(FILE_LIST_MAX_PATHS),
  truncated: z.boolean(),
}));
/** Workspace paths available to file pickers and the Files tree. */
export type WorkspaceFileList = z.infer<ReturnType<typeof WorkspaceFileListSchema>>;

/** Change marks relative to HEAD, excluding deleted files. */
export const WorkspaceFileChangesSchema = lazySchema(() => z.object({
  git: z.boolean(),
  entries: z.array(z.object({ path: z.string(), mark: z.enum(["M", "A"]) })).max(FILE_CHANGES_MAX_ENTRIES),
  truncated: z.boolean(),
}));
/** Bounded change marks for one workspace or thread checkout. */
export type WorkspaceFileChanges = z.infer<ReturnType<typeof WorkspaceFileChangesSchema>>;

/** Viewer content or the reason a file cannot be displayed as text. */
export const FileReadResultSchema = lazySchema(() => {
  const file = { path: z.string(), size: z.number().int().nonnegative() };
  return z.discriminatedUnion("kind", [
    z.object({
      ...file, kind: z.literal("text"), encoding: z.enum(["utf-8", "utf-16le", "utf-16be"]),
      content: z.string(),
      changedLines: z.array(z.tuple([z.number().int().positive(), z.number().int().positive()])).nullable(),
    }),
    z.object({ ...file, kind: z.literal("image"), mime: z.string(), url: z.string() }),
    z.object({ ...file, kind: z.literal("binary") }),
    z.object({ ...file, kind: z.literal("too-large"), limit: z.number().int().positive() }),
  ]);
});
/** Structured result of reading a workspace file. */
export type FileReadResult = z.infer<ReturnType<typeof FileReadResultSchema>>;
