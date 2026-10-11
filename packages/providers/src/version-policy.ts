const NUMERIC = /^(0|[1-9]\d*)$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parse(version: string) {
  const match = SEMVER.exec(version);
  if (!match || match[0] !== version) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && !NUMERIC.test(part))) return null;
  return { core: [match[1], match[2], match[3]], prerelease };
}

/** Whether a version is a complete SemVer string, safe to use as an npm version selector. */
export function isSemver(version: string): boolean {
  return parse(version) !== null;
}

function compareIdentifier(a: string, b: string): number {
  if (a === b) return 0;
  if (NUMERIC.test(a) && NUMERIC.test(b)) return a.length - b.length || (a > b ? 1 : -1);
  if (NUMERIC.test(a)) return -1;
  if (NUMERIC.test(b)) return 1;
  return a > b ? 1 : -1;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Number(b.length > 0) - Number(a.length > 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const order = compareIdentifier(a[i], b[i]);
    if (order !== 0) return order;
  }
  return 0;
}

function compare(a: string, b: string): number | null {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const order = compareIdentifier(left.core[i], right.core[i]);
    if (order !== 0) return order;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Returns false for malformed versions; otherwise compares SemVer precedence, including prereleases. */
export function meetsMinVersion(version: string, minimum: string): boolean {
  const order = compare(version, minimum);
  return order !== null && order >= 0;
}

/** Whether latest strictly exceeds installed; build metadata does not affect precedence. */
export function isNewer(latest: string, installed: string): boolean {
  const order = compare(latest, installed);
  return order !== null && order > 0;
}
