/** The links that decide whether a tool call outlives the turn that started it. */
export interface ToolCallLink {
  readonly id: string;
  readonly parentId: string | null | undefined;
  readonly background: boolean;
}

/**
 * Ids of background calls and every step under them. The provider keeps all of these
 * running after their turn ends, so only the background call's own settlement ends them.
 */
export function backgroundHeldToolIds(links: readonly ToolCallLink[]): Set<string> {
  return withDescendants(links, links.filter((link) => link.background).map((link) => link.id));
}

/**
 * Ids of the steps that end with background call `rootId`: every step under it at any depth,
 * short of a nested background call, which only its own settlement ends.
 */
export function stepsSettledWith(links: readonly ToolCallLink[], rootId: string): Set<string> {
  const ids = withDescendants(links.filter((link) => !link.background), [rootId]);
  ids.delete(rootId);
  return ids;
}

function withDescendants(links: readonly ToolCallLink[], roots: readonly string[]): Set<string> {
  const ids = new Set(roots);
  let size = -1;
  // Steps can be listed before their parent, so repeat until a pass adds nothing.
  while (ids.size !== size) {
    size = ids.size;
    for (const link of links) {
      if (link.parentId != null && ids.has(link.parentId)) ids.add(link.id);
    }
  }
  return ids;
}
