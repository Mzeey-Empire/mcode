#!/usr/bin/env bun
/** Run maintained agent and Electron harness script tests one file at a time. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const agentTestDirectory = NodePath.resolve(process.cwd(), "scripts", "agent", "__tests__");
const harnessTestDirectory = NodePath.resolve(process.cwd(), ".agents", "skills", "electorn-live-testing", "scripts");
const NODE_RUNTIME_TEST_FILES = new Set([
  "electron-live-testing.test.mjs",
  "frontend-performance-runner.test.mjs",
  "packaged-windows-acceleration-runner.test.mjs",
]);

/** Finds maintained agent test files and fails closed when none exist. */
export function discoverAgentTestFiles(directory) {
  const testFiles = NodeFS.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort();
  if (testFiles.length === 0) {
    throw new Error(`No agent tests found in ${directory}`);
  }
  return testFiles;
}

/** Selects maintained script tests, rejecting paths outside the test directories. */
export function selectAgentTestFiles(directories, requestedFiles) {
  if (requestedFiles.length === 0) {
    return directories.flatMap((directory) => discoverAgentTestFiles(directory).map((file) => NodePath.join(directory, file)));
  }

  return requestedFiles.map((requestedFile) => {
    const testFile = NodePath.resolve(process.cwd(), requestedFile);
    const testParent = NodePath.dirname(testFile);
    if (
      !testFile.endsWith(".test.mjs")
      || !directories.some((directory) => NodePath.relative(directory, testParent) === "")
      || !NodeFS.existsSync(testFile)
      || !NodeFS.lstatSync(testFile).isFile()
    ) {
      throw new Error(`Expected a maintained agent test file: ${requestedFile}`);
    }
    return testFile;
  });
}

const invokedScript = process.argv[1] ? NodePath.resolve(process.argv[1]) : null;
if (invokedScript === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url))) {
  const testFiles = selectAgentTestFiles([agentTestDirectory, harnessTestDirectory], process.argv.slice(2));
  for (const testFile of testFiles) {
    const file = NodePath.basename(testFile);
    // Bun cannot read the skill module under this worktree's Windows ACLs.
    const usesNode = NODE_RUNTIME_TEST_FILES.has(file)
      && NodePath.relative(agentTestDirectory, NodePath.dirname(testFile)) === "";
    const command = usesNode ? "node" : process.execPath;
    const argumentsForCommand = usesNode
      ? ["--test", testFile]
      : ["test", testFile];
    const result = NodeChildProcess.spawnSync(command, argumentsForCommand, {
      cwd: process.cwd(),
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
