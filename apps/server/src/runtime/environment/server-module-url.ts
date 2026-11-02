import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Returns the URL that a server module resolves its companion files against:
 * worker bundles, native modules, and staged CLIs.
 *
 * Packaged builds run the server as a compiled Bun executable. Bun replaces
 * each bundled module's path with the path it had on the build machine, so
 * `import.meta.url` names a folder that exists only on CI. The desktop shell
 * passes the real resources root, which holds the server bundle on disk.
 */
export function serverModuleUrl(moduleUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const resourcesRoot = env.MCODE_PACKAGED_RESOURCES_ROOT;
  if (!resourcesRoot) return moduleUrl;
  const serverEntry = NodePath.join(resourcesRoot, "app.asar.unpacked", "dist", "server", "server.cjs");
  return NodeURL.pathToFileURL(serverEntry).href;
}
