/** Extract the file name from a path (browser-safe, handles both / and \). */
export function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

/** Join a relative path onto a base, keeping the base's separator style. */
export function joinPaths(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return base.endsWith(sep) ? base + rel : base + sep + rel;
}

/** Parent directory of a path, or the path itself when it has no separator. */
export function dirname(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return cut > 0 ? filePath.slice(0, cut) : filePath;
}
