import type { Nodes, Root } from "hast";
import type { ReactElement } from "react";
import Markdown, { type Components, type Options, type UrlTransform } from "react-markdown";

/** Remark plugins for one render; they change the parsed tree, so they are part of the cache key. */
export type MarkdownRemarkPlugins = NonNullable<Options["remarkPlugins"]>;

/** Size limits for a {@link MarkdownTreeCache}. */
export interface MarkdownTreeCacheLimits {
  /** Most trees kept at once. */
  maxEntries: number;
  /** Most estimated heap bytes kept at once; a single tree over this is never kept. */
  maxBytes: number;
}

/** One cacheable Markdown render. */
export interface MarkdownTreeRender {
  content: string;
  remarkPlugins: MarkdownRemarkPlugins;
  components: Components;
  /**
   * Whether a fresh parse may be stored. Pass true only when the content is not expected to change
   * on the next render, so text that is still streaming does not evict settled messages.
   */
  admit: boolean;
}

interface CachedTree {
  remarkPlugins: MarkdownRemarkPlugins;
  tree: Root;
  bytes: number;
}

// Retained V8 heap tracks node count, not source length: a 860-character table held 128 KiB
// while a 1,086-character prose message held 12 KiB. Charging both terms covered the measured
// heap of prose, short user text, tables and link-dense lists, so the byte bound holds.
const ESTIMATED_HEAP_BYTES_PER_NODE = 260;
const ESTIMATED_HEAP_BYTES_PER_CHAR = 16;

/** Conservative estimate of the heap a parsed tree retains, used to enforce the byte bound. */
export function estimateMarkdownTreeBytes(tree: Root, content: string): number {
  let nodes = 0;
  const pending: Nodes[] = [tree];
  for (let node = pending.pop(); node; node = pending.pop()) {
    nodes += 1;
    if ("children" in node) for (const child of node.children) pending.push(child);
  }
  return nodes * ESTIMATED_HEAP_BYTES_PER_NODE + content.length * ESTIMATED_HEAP_BYTES_PER_CHAR;
}

// The cached tree has already been through react-markdown's URL rewrite, so replaying it must
// not rewrite the URLs a second time.
const keepUrl: UrlTransform = (url) => url;

/**
 * Least-recently-used cache of react-markdown's parsed HTML tree, keyed by the exact Markdown
 * source and the remark plugin list.
 *
 * A thread switch remounts every visible message, and parsing is the expensive part of
 * rendering one. Replaying a stored tree skips remark and rehype; react-markdown still turns the
 * tree into React elements with the caller's components, so anything rendered from component
 * props stays live.
 */
export class MarkdownTreeCache {
  private readonly entries = new Map<string, CachedTree>();
  private totalBytes = 0;

  /**
   * @param urlTransform Applied to every parse; fixed per cache because stored trees keep its output.
   * @param limits Entry and byte bounds; the oldest entries are evicted first.
   */
  constructor(
    private readonly urlTransform: UrlTransform,
    private readonly limits: MarkdownTreeCacheLimits,
  ) {}

  /** Renders Markdown to React elements, reusing a stored tree for the same source and plugins. */
  render({ content, remarkPlugins, components, admit }: MarkdownTreeRender): ReactElement {
    const cached = this.take(content, remarkPlugins);
    if (cached) {
      return Markdown({ children: "", rehypePlugins: [() => () => cached], urlTransform: keepUrl, components });
    }

    let parsed: Root | undefined;
    const element = Markdown({
      children: content,
      remarkPlugins,
      rehypePlugins: [() => (tree: Root) => { parsed = tree; }],
      urlTransform: this.urlTransform,
      components,
    });
    // react-markdown rewrites URLs in the captured tree after the plugins run, so the tree is
    // stored only once the render has finished.
    if (admit && parsed) this.store(content, { remarkPlugins, tree: parsed, bytes: estimateMarkdownTreeBytes(parsed, content) });
    return element;
  }

  private take(content: string, remarkPlugins: MarkdownRemarkPlugins): Root | null {
    const entry = this.entries.get(content);
    if (!entry || entry.remarkPlugins !== remarkPlugins) return null;
    this.entries.delete(content);
    this.entries.set(content, entry);
    return entry.tree;
  }

  private store(content: string, entry: CachedTree): void {
    if (entry.bytes > this.limits.maxBytes) return;
    this.remove(content);
    this.entries.set(content, entry);
    this.totalBytes += entry.bytes;
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limits.maxEntries && this.totalBytes <= this.limits.maxBytes) break;
      this.remove(oldest);
    }
  }

  private remove(content: string): void {
    const entry = this.entries.get(content);
    if (!entry) return;
    this.entries.delete(content);
    this.totalBytes -= entry.bytes;
  }
}
