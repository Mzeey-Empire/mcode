/** Where a link in a rendered markdown file points. */
export type MarkdownLinkTarget =
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "anchor"; readonly id: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "outside-root" }
  | { readonly kind: "ignored" };

const EXTERNAL_SCHEME = /^(https?:|mailto:)/i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE_LETTER = /^[a-z]:/i;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function stripQueryAndFragment(href: string): string {
  const end = href.search(/[?#]/);
  return end < 0 ? href : href.slice(0, end);
}

function normalise(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out;
}

function resolveScheme(href: string): MarkdownLinkTarget | null {
  if (href === "") return { kind: "ignored" };
  if (EXTERNAL_SCHEME.test(href)) return { kind: "external", url: href };
  if (href.startsWith("#")) {
    const id = decode(href.slice(1));
    return id ? { kind: "anchor", id } : { kind: "ignored" };
  }
  if (ANY_SCHEME.test(href) || href.startsWith("//")) return { kind: "ignored" };
  return null;
}

function resolveFile(fromPath: string, href: string): MarkdownLinkTarget {
  const target = decode(stripQueryAndFragment(href));
  if (target === null || target === "") return { kind: "ignored" };
  if (target.includes("\\") || target.includes("\0") || DRIVE_LETTER.test(target)) return { kind: "outside-root" };
  const base = target.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  const segments = normalise([...base, ...target.split("/")]);
  if (segments === null) return { kind: "outside-root" };
  return segments.length === 0 ? { kind: "ignored" } : { kind: "file", path: segments.join("/") };
}

/**
 * Resolves a link from the markdown file at `fromPath` (project-relative, `/`-separated).
 * Hrefs are untrusted file content: unknown schemes (a `C:/x` drive path parses as
 * one) are ignored, and anything that would climb above the project root or use
 * backslashes or NUL is reported as leaving the project.
 */
export function resolveMarkdownHref(fromPath: string, href: string): MarkdownLinkTarget {
  const trimmed = href.trim();
  return resolveScheme(trimmed) ?? resolveFile(fromPath, trimmed);
}
