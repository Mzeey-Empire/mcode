/**
 * Records how long each test file takes, for `test-duration-sequencer.ts`.
 *
 * Run with `--reporter=dot --reporter=<path to this file>`. New durations replace the
 * recorded ones for the files that ran, and entries for deleted files are dropped, so a
 * partial run refreshes only what it measured.
 */

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { Reporter, TestModule, Vitest } from "vitest/node";
import { readTestFileDurations, relativeTestPath, TEST_DURATIONS_FILE } from "./test-duration-sequencer.js";

export default class DurationReporter implements Reporter {
  private root = "";

  onInit(vitest: Vitest): void {
    this.root = vitest.config.root;
  }

  onTestRunEnd(testModules: readonly TestModule[]): void {
    const durations = readTestFileDurations(this.root);
    for (const testModule of testModules) {
      durations[relativeTestPath(this.root, testModule.moduleId)] = fileDuration(testModule);
    }
    const kept = Object.keys(durations)
      .filter((path) => NodeFS.existsSync(NodePath.join(this.root, path)))
      .sort()
      .map((path) => [path, durations[path]]);
    NodeFS.writeFileSync(
      NodePath.join(this.root, TEST_DURATIONS_FILE),
      `${JSON.stringify(Object.fromEntries(kept), null, 2)}\n`,
    );
  }
}

// Importing the file's modules is part of its cost, and for some files most of it, so
// count setup and collection as well as the tests themselves.
function fileDuration(testModule: TestModule): number {
  const d = testModule.diagnostic();
  return Math.round(d.environmentSetupDuration + d.prepareDuration + d.setupDuration + d.collectDuration + d.duration);
}
