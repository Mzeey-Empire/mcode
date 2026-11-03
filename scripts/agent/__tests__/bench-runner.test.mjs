import * as NodeAssertStrict from "node:assert/strict";
import * as NodeTest from "node:test";
import { findEnvironmentMismatches } from "../../perf/run-bench.mjs";

const environment = {
  host: { cpuModel: "Test CPU", cpuCount: 8, memoryBytes: 16_000_000_000, platform: "win32" },
  versions: { node: "22.0.0", bun: "1.3.0" },
};

NodeTest.test("identical environments have no mismatches", () => {
  NodeAssertStrict.default.deepEqual(findEnvironmentMismatches(environment, structuredClone(environment)), []);
});

NodeTest.test("CPU and Bun version differences report both values", () => {
  const current = {
    host: { ...environment.host, cpuModel: "Other CPU" },
    versions: { ...environment.versions, bun: "1.3.1" },
  };

  NodeAssertStrict.default.deepEqual(findEnvironmentMismatches(environment, current), [
    { field: "host.cpuModel", baseline: "Test CPU", current: "Other CPU" },
    { field: "versions.bun", baseline: "1.3.0", current: "1.3.1" },
  ]);
});

NodeTest.test("version keys present on only one side are mismatches", () => {
  const withoutBun = { host: environment.host, versions: { node: "22.0.0" } };

  NodeAssertStrict.default.deepEqual(findEnvironmentMismatches(environment, withoutBun), [
    { field: "versions.bun", baseline: "1.3.0", current: undefined },
  ]);
  NodeAssertStrict.default.deepEqual(findEnvironmentMismatches(withoutBun, environment), [
    { field: "versions.bun", baseline: undefined, current: "1.3.0" },
  ]);
});
