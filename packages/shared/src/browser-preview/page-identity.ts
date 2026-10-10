const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "gclid", "fbclid", "msclkid",
]);

/** Normalizes page identity by ignoring fragments, query order and tracking parameters. */
export function normalizePreviewPageIdentity(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    const kept = Array.from(url.searchParams.entries())
      .filter(([key]) => !TRACKING_PARAMS.has(key.toLowerCase()))
      .sort(([aKey, aValue], [bKey, bValue]) =>
        aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey),
      );
    url.search = "";
    for (const [key, value] of kept) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return rawUrl.split("#", 1)[0]?.trim() ?? rawUrl.trim();
  }
}
