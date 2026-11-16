import { describe, expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { staticMarkFiles } from "../mark-svg";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../../../../..");

describe("static mark files", () => {
  for (const [path, generated] of Object.entries(staticMarkFiles())) {
    it(`${path} matches the art module`, () => {
      const committed = NodeFS.readFileSync(NodePath.join(repoRoot, path), "utf8");
      expect(committed, `${path} drifted from the art module; run bun run --cwd apps/web brand:write`).toBe(generated);
    });
  }
});

/** Each ICO directory entry's image bytes, keyed by pixel width (0 in the header means 256). */
function icoImages(path: string): Map<number, Buffer> {
  const ico = NodeFS.readFileSync(NodePath.join(repoRoot, path));
  const images = new Map<number, Buffer>();
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const entry = 6 + 16 * i;
    const offset = ico.readUInt32LE(entry + 12);
    images.set(ico[entry] || 256, ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)));
  }
  return images;
}

describe("favicon", () => {
  it("is the desktop icon's 16, 32 and 48 px entries", () => {
    const favicon = icoImages("apps/web/public/favicon.ico");
    const desktop = icoImages("apps/desktop/build/icon.ico");
    expect([...favicon.keys()]).toEqual([16, 32, 48]);
    for (const [size, image] of favicon) {
      expect(image.equals(desktop.get(size) ?? Buffer.alloc(0)), `favicon ${size} px differs from icon.ico`).toBe(true);
    }
  });
});
