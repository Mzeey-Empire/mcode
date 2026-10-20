import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return { directory: fs.mkdtempSync(path.join(os.tmpdir(), "mcode-startup-log-")) };
});

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => fixture.directory, getVersion: () => "test" },
}));
vi.mock("@mcode/shared", () => ({ getMcodeDir: () => fixture.directory }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((executable: string) => {
      if (executable === process.execPath) return `${process.execPath}\n`;
      throw new Error(`Unexpected synchronous child process: ${executable}`);
    }),
    spawn: vi.fn((_executable: string, _args: string[], options: import("node:child_process").SpawnOptions) =>
      actual.spawn(process.execPath, ["-e", "require('node:fs').writeSync(2, 'Startup fixture failed\\n'); process.exit(1)"], {
        ...options, cwd: fixture.directory,
      })),
  };
});

import { SERVER_LOG_PATH, SERVER_ROTATED_LOG_PATH, spawnServerProcess } from "../child.js";

const STARTUP_ID = "00000000-0000-4000-8000-0000000000bb";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => NodeFS.rmSync(fixture.directory, { recursive: true, force: true }));

describe("server startup error capture", () => {
  it.each(["http://localhost:5173", ""])("retains an immediate child failure with renderer URL %s", async (rendererUrl) => {
    vi.stubEnv("ELECTRON_RENDERER_URL", rendererUrl);
    vi.stubEnv("BUN", process.execPath);
    NodeFS.writeFileSync(SERVER_LOG_PATH, "Previous startup failed\n");
    const { child, stderrStream } = spawnServerProcess(19500, process.platform, STARTUP_ID);
    try {
      const [code] = await NodeEvents.once(child, "exit");
      expect(code).toBe(1);
      expect(NodeChildProcess.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ MCODE_STARTUP_ID: STARTUP_ID }) }),
      );
      expect(NodeFS.readFileSync(SERVER_LOG_PATH, "utf8")).toBe("Startup fixture failed\n");
      expect(NodeFS.readFileSync(SERVER_ROTATED_LOG_PATH, "utf8")).toBe("Previous startup failed\n");
    } finally {
      stderrStream?.end();
      if (stderrStream) await NodeEvents.once(stderrStream, "close");
    }
  });
});

describe("server child environment", () => {
  it("hands the server the desktop data directory and runs no git lookups", async () => {
    const environment = await startServer();

    expect(environment.MCODE_DATA_DIR).toBe(fixture.directory);
    expect(environment).not.toHaveProperty("MCODE_GIT_BRANCH");
    expect(environment).not.toHaveProperty("MCODE_GIT_TOPLEVEL");
    expect(vi.mocked(NodeChildProcess.execFileSync).mock.calls.some(([executable]) => executable === "git")).toBe(false);
  });
});

async function startServer(): Promise<NodeJS.ProcessEnv> {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
  vi.stubEnv("BUN", process.execPath);
  const { child, stderrStream } = spawnServerProcess(19500, process.platform, STARTUP_ID);
  const call = vi.mocked(NodeChildProcess.spawn).mock.calls.at(-1);
  if (!call?.[2]?.env) throw new Error("The startup fixture did not receive a child environment");
  const environment = call[2].env;
  try {
    await NodeEvents.once(child, "exit");
  } finally {
    stderrStream.end();
    await NodeEvents.once(stderrStream, "close");
  }
  return environment;
}

