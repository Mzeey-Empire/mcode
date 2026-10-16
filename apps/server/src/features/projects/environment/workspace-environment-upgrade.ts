import { z } from "zod";
import {
  WORKSPACE_ENVIRONMENT_LEGACY_VERSION,
  WORKSPACE_ENVIRONMENT_VERSION,
  WorkspaceEnvironmentCommandSchema,
  WorkspaceEnvironmentDocumentSchema,
  type WorkspaceEnvironmentDocument,
} from "@mcode/contracts";

const legacyDocument = z.object({
  version: z.literal(WORKSPACE_ENVIRONMENT_LEGACY_VERSION),
  setup: WorkspaceEnvironmentCommandSchema(),
  actions: z.array(z.object({ id: z.string() }).passthrough()),
}).passthrough();

/** Upgrade legacy Setup in memory on every storage read, preserving the source bytes until Save. */
export function upgradeEnvironmentDocument(value: unknown): WorkspaceEnvironmentDocument {
  const legacy = legacyDocument.safeParse(value);
  if (!legacy.success) return WorkspaceEnvironmentDocumentSchema().parse(value);
  const { setup, ...document } = legacy.data;
  const ids = new Set(document.actions.map((action) => action.id));
  let id = "setup";
  for (let suffix = 2; ids.has(id); suffix++) id = `setup-${suffix}`;
  return WorkspaceEnvironmentDocumentSchema().parse({
    ...document,
    version: WORKSPACE_ENVIRONMENT_VERSION,
    actions: [{ id, name: "setup", command: setup, runOnStartup: true }, ...document.actions],
  });
}
