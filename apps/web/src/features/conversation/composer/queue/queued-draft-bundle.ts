import type { PreviewAnnotationBundle } from "@mcode/contracts";
import { browserNoteElements, readVisibleBrowserNotePages, removeTakenBrowserNotePages } from "../draft/draft-browser-notes";
import { readVisibleDiffComments, removeTakenDiffComments } from "../draft/draft-diff-comments";
import { readVisibleFileComments, removeTakenFileComments } from "../draft/draft-file-comments";
import type { FrozenDraftContent } from "../draft/draft-submission";
import { whenAdmissionChecksSettle } from "./queued-draft-holds";

/**
 * The visible draft elements a queued bundle carries, matched by id. Re-queueing an edited
 * message holds exactly these again; anything else visible stays out of the entry.
 */
export function readDraftContentInBundle(
  threadId: string,
  bundle: PreviewAnnotationBundle | undefined,
): FrozenDraftContent {
  const ids = new Set(bundle?.annotations.map((annotation) => annotation.id) ?? []);
  return {
    diffComments: readVisibleDiffComments(threadId).filter((comment) => ids.has(comment.id)),
    fileComments: readVisibleFileComments(threadId).filter((comment) => ids.has(comment.id)),
    browserNotePages: readVisibleBrowserNotePages(threadId)
      .map((page) => ({ ...page, notes: page.notes.filter((note) => ids.has(note.id)) }))
      .filter((page) => page.notes.length > 0),
  };
}

/**
 * Drops the draft copies of the elements a queued bundle carries once every pending admission
 * check settles. An entry re-queued without a hold owns its bundle alone, but a check still
 * running for the entry it replaced can thaw the same elements back into the draft, where a
 * later Send would carry them a second time.
 */
export function dropDraftContentInBundleWhenSettled(
  threadId: string,
  bundle: PreviewAnnotationBundle | undefined,
): void {
  if (!bundle) return;
  void whenAdmissionChecksSettle().then(() => {
    const content = readDraftContentInBundle(threadId, bundle);
    removeTakenBrowserNotePages(threadId, browserNoteElements(content.browserNotePages));
    removeTakenDiffComments(threadId, content.diffComments);
    removeTakenFileComments(threadId, content.fileComments);
  });
}
