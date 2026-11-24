import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";

import { billedMinutes, choosePool, classifyJob, main } from "../runner-pool.mjs";

const REPO = "Mzeey-Empire/mcode";
const NOW = new Date("2026-11-09T12:00:00Z");

function job(labels, minutes, overrides = {}) {
  return {
    labels,
    run_attempt: 1,
    runner_name: "runner-1",
    started_at: "2026-11-09T10:00:00Z",
    completed_at: new Date(Date.parse("2026-11-09T10:00:00Z") + minutes * 60_000).toISOString(),
    ...overrides,
  };
}

/**
 * Fakes the gh calls the script makes, with --jq projections applied.
 * `total` overrides a window's reported run count; `jobFailures` maps a run id
 * to how many of its job reads fail with a 502 before one succeeds.
 */
function createHarness({ runs = [], jobs = new Map(), variables = new Map(), total, jobFailures = new Map() } = {}) {
  const writes = [];
  const stdout = [];
  const stderr = [];
  const sleeps = [];
  const listedWindows = [];
  const notFound = () => Object.assign(new Error("gh failed"), { stderr: "gh: Not Found (HTTP 404)" });
  const serverError = () => Object.assign(new Error("gh failed"), { stderr: "gh: Server Error (HTTP 502)" });
  const toLines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

  const variableCall = (name, method, field) => {
    if (method === "POST") {
      variables.set(field("name"), field("value"));
      writes.push(field("name"));
      return "";
    }
    if (!variables.has(name)) throw notFound();
    if (method === "GET") return JSON.stringify({ name, value: variables.get(name) });
    variables.set(name, field("value"));
    writes.push(name);
    return "";
  };

  const listRuns = (endpoint) => {
    // Every fake run is created on 9 November, so only windows covering that day list them.
    const [, from, to] = endpoint.match(/created=([\d-]+)\.\.([\d-]+)/);
    listedWindows.push(`${from}..${to}`);
    if (from > "2026-11-09" || to < "2026-11-09") return "";
    const count = typeof total === "function" ? total(from, to) : total ?? runs.length;
    return toLines(runs.map((run) => ({ ...run, total: count })));
  };

  const listJobs = (runId) => {
    const remaining = jobFailures.get(runId) ?? 0;
    if (remaining > 0) {
      jobFailures.set(runId, remaining - 1);
      throw serverError();
    }
    return toLines(jobs.get(runId) ?? []);
  };

  const gh = (args) => {
    const endpoint = args.find((arg) => /^(repos|orgs)\//.test(arg));
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const field = (key) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    const variable = endpoint.match(/actions\/variables(?:\/(\w+))?$/);
    const runId = endpoint.match(/runs\/(\d+)\/jobs/)?.[1];
    if (endpoint === "orgs/Mzeey-Empire/repos?per_page=100") return toLines(["mcode"]);
    if (variable) return variableCall(variable[1], method, field);
    if (/actions\/runs\?created=/.test(endpoint)) return listRuns(endpoint);
    if (runId) return listJobs(Number(runId));
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };

  const io = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const sleep = async (milliseconds) => {
    sleeps.push(milliseconds);
  };

  return {
    writes,
    variables,
    stdout,
    stderr,
    sleeps,
    listedWindows,
    run: (argv = ["--repo", REPO, "--apply"]) => main(argv, { gh, io, now: NOW, sleep }),
    used: () => JSON.parse(variables.get("CI_RUNNER_USAGE")).used,
  };
}

NodeTest.default("weights each provider job in 2 vCPU Linux minutes and ignores GitHub-hosted jobs", () => {
  NodeAssertStrict.equal(classifyJob(["ubuntu-24.04"]), null);
  NodeAssertStrict.deepEqual(classifyJob(["blacksmith-2vcpu-ubuntu-2404"]), { provider: "blacksmith", weight: 1 });
  NodeAssertStrict.deepEqual(classifyJob(["blacksmith-4vcpu-ubuntu-2404"]), { provider: "blacksmith", weight: 2 });
  NodeAssertStrict.deepEqual(classifyJob(["avrea-ubuntu-latest"]), { provider: "avrea", weight: 1 });
  NodeAssertStrict.deepEqual(classifyJob(["avrea-ubuntu-latest-4-vcpu"]), { provider: "avrea", weight: 2 });
  NodeAssertStrict.deepEqual(classifyJob(["avrea-windows-2025-2-vcpu"]), { provider: "avrea", weight: 2 });
  NodeAssertStrict.deepEqual(classifyJob(["avrea-ubuntu-24.04-arm-2-vcpu"]), { provider: "avrea", weight: 3 });
  NodeAssertStrict.deepEqual(classifyJob(["blacksmith-6vcpu-macos-26"]), { provider: "blacksmith", weight: 20 });
  NodeAssertStrict.deepEqual(classifyJob(["avrea-macos-26-16-vcpu"]), { provider: "avrea", weight: 40 });
});

NodeTest.default("bills Avrea by the second and rounds each Blacksmith job up to a whole 2 vCPU minute", () => {
  const fifteenSeconds = job([], 0.25);
  NodeAssertStrict.equal(billedMinutes(fifteenSeconds, classifyJob(["avrea-ubuntu-latest-4-vcpu"])), 0.5);
  NodeAssertStrict.equal(billedMinutes(fifteenSeconds, classifyJob(["blacksmith-4vcpu-ubuntu-2404"])), 1);
  NodeAssertStrict.equal(billedMinutes(job([], 2.25), classifyJob(["blacksmith-4vcpu-ubuntu-2404"])), 5);
});

NodeTest.default("keeps a provider in the pool only while it is under today's share and the safety margin", () => {
  // 9 November: today's share of 3,000 over 30 days is 900.
  NodeAssertStrict.deepEqual(choosePool({ avrea: 899, blacksmith: 900 }, NOW), ["avrea", "github"]);
  // 30 November: the share is 3,000, so the 60-minute margin decides.
  const lastDay = new Date("2026-11-30T23:00:00Z");
  NodeAssertStrict.deepEqual(choosePool({ avrea: 2_939, blacksmith: 2_940 }, lastDay), ["avrea", "github"]);
  NodeAssertStrict.deepEqual(choosePool({ avrea: 5_000, blacksmith: 5_000 }, lastDay), ["github"]);
});

NodeTest.default("counts each finished run once, picks up unfinished runs later, and counts only new attempts of re-runs", async () => {
  const harness = createHarness({
    runs: [
      { id: 101, status: "completed", run_attempt: 1 },
      { id: 102, status: "in_progress", run_attempt: 1 },
    ],
    jobs: new Map([
      [101, [job(["avrea-ubuntu-latest-4-vcpu"], 3), job(["ubuntu-24.04"], 50), job(["blacksmith-2vcpu-ubuntu-2404"], 1.5)]],
      [102, [job(["avrea-ubuntu-latest-2-vcpu"], 5)]],
    ]),
  });

  NodeAssertStrict.equal(await harness.run(), 0, harness.stderr.join("\n"));
  NodeAssertStrict.deepEqual(harness.used(), { avrea: 6, blacksmith: 2 });

  // Run 102 finishes; run 101 is re-run with one more Avrea job.
  const runs = [
    { id: 101, status: "completed", run_attempt: 2 },
    { id: 102, status: "completed", run_attempt: 1 },
  ];
  const second = createHarness({
    runs,
    jobs: new Map([
      [101, [job(["avrea-ubuntu-latest-4-vcpu"], 3), job(["avrea-ubuntu-latest-2-vcpu"], 4, { run_attempt: 2 })]],
      [102, [job(["avrea-ubuntu-latest-2-vcpu"], 5)]],
    ]),
    variables: harness.variables,
  });
  NodeAssertStrict.equal(await second.run(), 0, second.stderr.join("\n"));
  NodeAssertStrict.deepEqual(second.used(), { avrea: 6 + 5 + 4, blacksmith: 2 });

  // A third pass with nothing new changes nothing.
  const third = createHarness({ runs, jobs: new Map(), variables: harness.variables });
  NodeAssertStrict.equal(await third.run(), 0, third.stderr.join("\n"));
  NodeAssertStrict.deepEqual(third.used(), { avrea: 15, blacksmith: 2 });
});

NodeTest.default("retries a transient GitHub error instead of failing the pass", async () => {
  const harness = createHarness({
    runs: [{ id: 101, status: "completed", run_attempt: 1 }],
    jobs: new Map([[101, [job(["avrea-ubuntu-latest-2-vcpu"], 3)]]]),
    jobFailures: new Map([[101, 2]]),
  });

  NodeAssertStrict.equal(await harness.run(), 0, harness.stderr.join("\n"));
  NodeAssertStrict.deepEqual(harness.used(), { avrea: 3, blacksmith: 0 });
  NodeAssertStrict.equal(harness.sleeps.length, 2);
});

NodeTest.default("a pass that fails part way saves the runs before the failure, and the next pass counts the rest once", async () => {
  // Eight runs span two concurrent batches, and run 103 keeps failing after
  // every retry, so the runs after it in its batch are read but not counted.
  const ids = [101, 102, 103, 104, 105, 106, 107, 108];
  const runs = ids.map((id) => ({ id, status: "completed", run_attempt: 1 }));
  const jobs = new Map(ids.map((id, index) => [id, [job(["avrea-ubuntu-latest-2-vcpu"], index + 1)]]));
  const allMinutes = ids.reduce((sum, _id, index) => sum + index + 1, 0);

  const failing = createHarness({ runs, jobs, jobFailures: new Map([[103, Infinity]]) });
  NodeAssertStrict.equal(await failing.run(), 1);
  NodeAssertStrict.deepEqual(failing.used(), { avrea: 1 + 2, blacksmith: 0 });
  NodeAssertStrict.deepEqual(failing.writes, ["CI_RUNNER_USAGE"], "a partial tally must not rewrite the pool");

  const resumed = createHarness({ runs, jobs, variables: failing.variables });
  NodeAssertStrict.equal(await resumed.run(), 0, resumed.stderr.join("\n"));
  NodeAssertStrict.deepEqual(resumed.used(), { avrea: allMinutes, blacksmith: 0 });
});

NodeTest.default("a dry run writes nothing, and --apply creates the variables when they are missing", async () => {
  const options = () => ({ runs: [], variables: new Map() });
  const dry = createHarness(options());
  NodeAssertStrict.equal(await dry.run(["--repo", REPO]), 0);
  NodeAssertStrict.deepEqual(dry.writes, []);
  NodeAssertStrict.ok(dry.stdout.includes("CI_RUNNER_POOL=avrea,blacksmith,github"));

  const applied = createHarness(options());
  NodeAssertStrict.equal(await applied.run(), 0);
  NodeAssertStrict.deepEqual(applied.writes, ["CI_RUNNER_USAGE", "CI_RUNNER_POOL"]);
  NodeAssertStrict.equal(applied.variables.get("CI_RUNNER_POOL"), "avrea,blacksmith,github");
});

NodeTest.default("starts a fresh tally in a new month but refuses a corrupt one", async () => {
  const lastMonth = JSON.stringify({ month: "2026-10", used: { avrea: 2_900, blacksmith: 2_900 }, repos: { mcode: { maxId: 101 } } });
  const fresh = createHarness({ variables: new Map([["CI_RUNNER_USAGE", lastMonth]]) });
  NodeAssertStrict.equal(await fresh.run(["--repo", REPO]), 0);
  NodeAssertStrict.ok(fresh.stdout.includes("CI_RUNNER_POOL=avrea,blacksmith,github"));

  const corrupt = createHarness({ variables: new Map([["CI_RUNNER_USAGE", '{"oops":1}']]) });
  NodeAssertStrict.equal(await corrupt.run(), 1);
  NodeAssertStrict.deepEqual(corrupt.writes, []);
});

NodeTest.default("splits a window that reaches GitHub's 1,000-run search limit", async () => {
  const harness = createHarness({
    runs: [{ id: 101, status: "completed", run_attempt: 1 }],
    jobs: new Map([[101, [job(["avrea-ubuntu-latest-2-vcpu"], 3)]]]),
    total: (from, to) => (from === to ? 1 : 1_000),
  });

  NodeAssertStrict.equal(await harness.run(), 0, harness.stderr.join("\n"));
  NodeAssertStrict.deepEqual(harness.used(), { avrea: 3, blacksmith: 0 });
  NodeAssertStrict.deepEqual(harness.listedWindows, ["2026-11-01..2026-11-07", "2026-11-08..2026-11-09", "2026-11-08..2026-11-08", "2026-11-09..2026-11-09"]);
});

NodeTest.default("fails instead of undercounting when a single day reaches GitHub's 1,000-run search limit", async () => {
  const harness = createHarness({ runs: [{ id: 1, status: "completed", run_attempt: 1 }], total: 1_000 });
  NodeAssertStrict.equal(await harness.run(), 1);
  NodeAssertStrict.match(harness.stderr.join("\n"), /over 1000 runs on 2026-11-09/);
  NodeAssertStrict.deepEqual(harness.writes, []);
});
