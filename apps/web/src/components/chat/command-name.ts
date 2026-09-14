/**
 * Collapse an absolute-path collision prefix to its basename for display.
 * Devin names project skills `<abs project path>:<skill>` when the name
 * collides with a user-level skill, so the picker would otherwise show the
 * whole path. Non-path prefixes (`claude:`, `superpowers:`) pass through.
 */
export function shortenPathPrefixedName(name: string): string {
  const sep = name.lastIndexOf(":");
  if (sep <= 0) return name;
  const prefix = name.slice(0, sep);
  if (!/[\\/]/.test(prefix)) return name;
  const base = prefix.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);
  return base ? `${base}${name.slice(sep)}` : name;
}
