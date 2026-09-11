import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
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

const originalGitEnvironment = {
  branch: process.env.MCODE_GIT_BRANCH,
  topLevel: process.env.MCODE_GIT_TOPLEVEL,
};
const serverCwd = NodePath.resolve(process.cwd(), "dist", "server");

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  restoreGitEnvironment();
});
afterAll(() => NodeFS.rmSync(fixture.directory, { recursive: true, force: true }));

describe("server startup error capture", () => {
  it.each(["http://localhost:5173", ""])("retains an immediate child failure with renderer URL %s", async (rendererUrl) => {
    vi.stubEnv("ELECTRON_RENDERER_URL", rendererUrl);
    vi.stubEnv("BUN", process.execPath);
    vi.stubEnv("MCODE_GIT_BRANCH", "test");
    vi.stubEnv("MCODE_GIT_TOPLEVEL", fixture.directory);
    NodeFS.writeFileSync(SERVER_LOG_PATH, "Previous startup failed\n");
    const { child, stderrStream } = spawnServerProcess(19500, process.platform);
    try {
      const [code] = await NodeEvents.once(child, "exit");
      expect(code).toBe(1);
      expect(NodeChildProcess.spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ windowsHide: true }),
      );
      expect(NodeFS.readFileSync(SERVER_LOG_PATH, "utf8")).toBe("Startup fixture failed\n");
      expect(NodeFS.readFileSync(SERVER_ROTATED_LOG_PATH, "utf8")).toBe("Previous startup failed\n");
    } finally {
      stderrStream?.end();
      if (stderrStream) await NodeEvents.once(stderrStream, "close");
    }
  });
});

describe("development Git metadata", () => {
  it("uses one combined lookup when both values are missing", async () => {
    clearGitEnvironment();
    configureGit((args) => {
      expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD", "--show-toplevel"]);
      return "feature/metadata\nC:/checkout\n";
    });

    const environment = await startServer();

    expect(environment).toMatchObject({ MCODE_GIT_BRANCH: "feature/metadata", MCODE_GIT_TOPLEVEL: "C:/checkout" });
    expect(gitCalls()).toEqual([
      ["git", ["rev-parse", "--abbrev-ref", "HEAD", "--show-toplevel"], { encoding: "utf-8", timeout: 3_000, cwd: serverCwd, windowsHide: true }],
    ]);
  });

  it("does not store detached HEAD as the branch", async () => {
    clearGitEnvironment();
    configureGit(() => "HEAD\nC:/checkout\n");

    const environment = await startServer();

    expect(environment).not.toHaveProperty("MCODE_GIT_BRANCH");
    expect(environment).toMatchObject({ MCODE_GIT_TOPLEVEL: "C:/checkout" });
  });

  it("looks up only the top level when the branch is supplied", async () => {
    vi.stubEnv("MCODE_GIT_BRANCH", "supplied-branch");
    vi.stubEnv("MCODE_GIT_TOPLEVEL", "");
    configureGit((args) => {
      expect(args).toEqual(["rev-parse", "--show-toplevel"]);
      return "C:/checkout\n";
    });

    const environment = await startServer();

    expect(environment).toMatchObject({ MCODE_GIT_BRANCH: "supplied-branch", MCODE_GIT_TOPLEVEL: "C:/checkout" });
    expect(gitCalls()).toEqual([
      ["git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8", timeout: 3_000, cwd: serverCwd, windowsHide: true }],
    ]);
  });

  it("looks up only the branch when the top level is supplied", async () => {
    vi.stubEnv("MCODE_GIT_BRANCH", "");
    vi.stubEnv("MCODE_GIT_TOPLEVEL", "C:/checkout");
    configureGit((args) => {
      expect(args).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
      return "feature/metadata\n";
    });

    const environment = await startServer();

    expect(environment).toMatchObject({ MCODE_GIT_BRANCH: "feature/metadata", MCODE_GIT_TOPLEVEL: "C:/checkout" });
    expect(gitCalls()).toEqual([
      ["git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", timeout: 3_000, cwd: serverCwd, windowsHide: true }],
    ]);
  });

  it("continues server startup when Git metadata is unavailable", async () => {
    clearGitEnvironment();
    configureGit(() => { throw new Error("Git metadata is unavailable"); });

    const environment = await startServer();

    expect(environment).not.toHaveProperty("MCODE_GIT_BRANCH");
    expect(environment).not.toHaveProperty("MCODE_GIT_TOPLEVEL");
    expect(gitCalls()).toHaveLength(1);
  });
});

function configureGit(response: (args: readonly string[]) => string): void {
  vi.mocked(NodeChildProcess.execFileSync).mockImplementation((executable, args) => {
    if (executable === process.execPath) return `${process.execPath}\n`;
    if (executable === "git") return response(args ?? []);
    throw new Error(`Unexpected synchronous child process: ${String(executable)}`);
  });
}

function gitCalls() {
  return vi.mocked(NodeChildProcess.execFileSync).mock.calls.filter(([executable]) => executable === "git");
}

async function startServer(): Promise<NodeJS.ProcessEnv> {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
  vi.stubEnv("BUN", process.execPath);
  const { child, stderrStream } = spawnServerProcess(19500, process.platform);
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

function clearGitEnvironment(): void {
  delete process.env.MCODE_GIT_BRANCH;
  delete process.env.MCODE_GIT_TOPLEVEL;
}

function restoreGitEnvironment(): void {
  if (originalGitEnvironment.branch === undefined) delete process.env.MCODE_GIT_BRANCH;
  else process.env.MCODE_GIT_BRANCH = originalGitEnvironment.branch;
  if (originalGitEnvironment.topLevel === undefined) delete process.env.MCODE_GIT_TOPLEVEL;
  else process.env.MCODE_GIT_TOPLEVEL = originalGitEnvironment.topLevel;
}
