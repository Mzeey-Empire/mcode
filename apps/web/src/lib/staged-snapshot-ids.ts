import type { PreviewAnnotationBundle } from "@mcode/contracts/models/browser-preview";

/**
 * Ids of the staged page snapshots a Send carries. A staged snapshot travels with an empty
 * `sourcePath` and its staging id as `id`; the server resolves it from draft storage.
 */
export function stagedSnapshotIds(bundle: PreviewAnnotationBundle | undefined): string[] {
  return bundle?.schemaVersion === 2
    ? bundle.pages.filter((page) => page.snapshot.sourcePath === "").map((page) => page.snapshot.id)
    : [];
}
