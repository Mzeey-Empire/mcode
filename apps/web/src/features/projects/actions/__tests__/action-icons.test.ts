import { describe, expect, it } from "vitest";
import {
  ACTION_ICONS,
  defaultActionIconId,
  isActionIconId,
  resolveActionIconId,
  shellActionIconId,
} from "../action-icons";

describe("defaultActionIconId", () => {
  it.each([
    ["bun run dev", "bun"],
    ["cargo test", "rust"],
    ["pwsh -File x.ps1", "powershell"],
    ["./run.sh", "play"],
    ["", "play"],
  ])("maps %j to %s", (command, expected) => {
    expect(defaultActionIconId(command)).toBe(expected);
  });

  it("skips leading env assignments, quoted values included", () => {
    expect(defaultActionIconId("FOO=1 bun run dev")).toBe("bun");
    expect(defaultActionIconId('GREETING="hello there" NODE_ENV=test pnpm test')).toBe("pnpm");
    expect(defaultActionIconId("NAME='a b' docker compose up")).toBe("docker");
  });

  it("keeps an assignment value with escaped whitespace out of the command word", () => {
    expect(defaultActionIconId(String.raw`FOO=hello\ world bun run dev`)).toBe("bun");
  });

  it("does not treat inherited object keys as command words", () => {
    expect(defaultActionIconId("constructor")).toBe("play");
    expect(defaultActionIconId("__proto__ --flag")).toBe("play");
  });

  it("reads the word after an npx or bunx prefix", () => {
    expect(defaultActionIconId("npx vitest run")).toBe("vitest");
    expect(defaultActionIconId("FOO=1 bunx playwright test")).toBe("playwright");
  });

  it("falls back to play when a runner has nothing after it or runs an unknown tool", () => {
    expect(defaultActionIconId("npx")).toBe("play");
    expect(defaultActionIconId("npx some-unknown-tool")).toBe("play");
  });

  it("reads a program path by its basename and ignores .exe", () => {
    expect(defaultActionIconId("C:\\tools\\bun.exe run dev")).toBe("bun");
    expect(defaultActionIconId("/usr/local/bin/cargo build")).toBe("rust");
  });

  it("uses the first real line of a multi-line script", () => {
    expect(defaultActionIconId("\n# build everything\ncargo build\nbun test")).toBe("rust");
  });
});

describe("resolveActionIconId", () => {
  it("returns a stored id this build knows", () => {
    expect(resolveActionIconId("rocket", "bun run dev")).toBe("rocket");
  });

  it("returns the derived default for an unknown stored id", () => {
    expect(resolveActionIconId("from-a-newer-build", "bun run dev")).toBe("bun");
  });

  it("returns the derived default when nothing is stored", () => {
    expect(resolveActionIconId(undefined, "cargo test")).toBe("rust");
  });

  it("does not treat inherited object keys as icon ids", () => {
    expect(isActionIconId("toString")).toBe(false);
    expect(resolveActionIconId("constructor", "cargo test")).toBe("rust");
  });
});

describe("shellActionIconId", () => {
  it.each([
    ["pwsh", "powershell"],
    ["powershell", "powershell"],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "powershell"],
    ["bash", "shell"],
    ["/bin/zsh", "shell"],
    ["cmd", "shell"],
    ["wsl", "shell"],
    ["nushell", "shell"],
    ["constructor", "shell"],
  ])("maps %s to %s", (shell, expected) => {
    expect(shellActionIconId(shell)).toBe(expected);
  });
});

describe("ACTION_ICONS", () => {
  it("keeps every id storable by the environment document", () => {
    for (const id of Object.keys(ACTION_ICONS)) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    }
  });
});
