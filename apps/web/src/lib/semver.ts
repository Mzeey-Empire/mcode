/**
 * Compare two version strings using semver precedence rules.
 *
 * Numeric segments compared numerically; presence-of-prerelease is less than
 * absence at the same MAJOR.MINOR.PATCH; mixed prerelease identifiers follow
 * semver §11.4 (numeric < alphanumeric, shorter prefix < longer when prefix
 * equal). Build metadata (`+...`) is not handled.
 *
 * @param a - First version
 * @param b - Second version
 * @returns true if `a > b`
 */
export function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.split("-", 2);
    const nums = main.split(".").map((n) => Number(n));
    return { nums, pre: pre ?? null };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const ai = A.nums[i] ?? 0;
    const bi = B.nums[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  // Equal core. No-prerelease > has-prerelease.
  if (A.pre === null && B.pre !== null) return true;
  if (A.pre !== null && B.pre === null) return false;
  if (A.pre === null && B.pre === null) return false;
  const ap = (A.pre as string).split(".");
  const bp = (B.pre as string).split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const xn = Number(x);
    const yn = Number(y);
    const xIsNum = !Number.isNaN(xn);
    const yIsNum = !Number.isNaN(yn);
    if (xIsNum && yIsNum) {
      if (xn !== yn) return xn > yn;
    } else if (xIsNum) {
      return false;
    } else if (yIsNum) {
      return true;
    } else if (x !== y) {
      return x > y;
    }
  }
  return false;
}
