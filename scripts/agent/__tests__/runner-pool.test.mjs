import * as NodeTest from "node:test";
import * as NodeAssertStrict from "node:assert/strict";

import { choosePool, classifyJob, main } from "../runner-pool.mjs";

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

/** Fakes the gh calls the script makes, with --jq projections applied. */
function createHarness({ runs = [], jobs = new Map(), variables = new Map(), total } = {}) {
  const writes = [];
  const stdout = [];
  const stderr = [];
  const notFound = () => Object.assign(new Error("gh failed"), { stderr: "gh: Not Found (HTTP 404)" });

  const gh = (args) => {
    const endpoint = args.find((arg) => /^(repos|orgs)\//.test(arg));
    const method = args.includes("--method") ? args[args.indexOf("--method") + 1] : "GET";
    const field = (key) => args.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1);
    if (endpoint === "orgs/Mzeey-Empire/repos?per_page=100") {
      return `${JSON.stringify("mcode")}\n`;
    }
    const variable = endpoint.match(/actions\/variables\/(\w+)$/)?.[1];
    if (variable && method === "GET") {
      if (!variables.has(variable)) throw notFound();
      return JSON.stringify({ name: variable, value: variables.get(variable) });
    }
    if (variable && method === "PATCH") {
      if (!variables.has(variable)) throw notFound();
      variables.set(variable, field("value"));
      writes.push(variable);
      return "";
    }
    if (endpoint.endsWith("actions/variables") && method === "POST") {
      variables.set(field("name"), field("value"));
      writes.push(field("name"));
      return "";
    }
    if (/actions\/runs\?created=/.test(endpoint)) {
      const from = endpoint.match(/created=([\d-]+)\.\./)[1];
      // Every fake run is created on 9 November, so only that window lists them.
      const listed = from <= "2026-11-09" && endpoint.includes("..2026-11-") && from >= "2026-11-08" ? runs : [];
      return listed.map((run) => JSON.stringify({ ...run, total: total ?? runs.length })).join("\n");
    }
    const runId = endpoint.match(/runs\/(\d+)\/jobs/)?.[1];
    if (runId) {
      return (jobs.get(Number(runId)) ?? []).map((entry) => JSON.stringify(entry)).join("\n");
    }
    throw new Error(`Unexpected gh call: ${args.join(" ")}`);
  };

  return {
    gh,
    writes,
    variables,
    stdout,
    stderr,
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
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

NodeTest.default("keeps a provider in the pool only while it is under today's share and the safety margin", () => {
  // 9 November: today's share of 3,000 over 30 days is 900.
  NodeAssertStrict.deepEqual(choosePool({ avrea: 899, blacksmith: 900 }, NOW), ["avrea", "github"]);
  // 30 November: the share is 3,000, so the 300-minute margin decides.
  const lastDay = new Date("2026-11-30T23:00:00Z");
  NodeAssertStrict.deepEqual(choosePool({ avrea: 2_699, blacksmith: 2_700 }, lastDay), ["avrea", "github"]);
  NodeAssertStrict.deepEqual(choosePool({ avrea: 5_000, blacksmith: 5_000 }, lastDay), ["github"]);
});

NodeTest.default("counts each finished run once, picks up unfinished runs later, and counts only new attempts of re-runs", () => {
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
  const run = () => main(["--repo", REPO, "--apply"], { gh: harness.gh, io: harness.io, now: NOW });

  NodeAssertStrict.equal(run(), 0, harness.stderr.join("\n"));
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
  NodeAssertStrict.equal(main(["--repo", REPO, "--apply"], { gh: second.gh, io: second.io, now: NOW }), 0, second.stderr.join("\n"));
  NodeAssertStrict.deepEqual(second.used(), { avrea: 6 + 5 + 4, blacksmith: 2 });

  // A third pass with nothing new changes nothing.
  const third = createHarness({ runs, jobs: new Map(), variables: harness.variables });
  NodeAssertStrict.equal(main(["--repo", REPO, "--apply"], { gh: third.gh, io: third.io, now: NOW }), 0, third.stderr.join("\n"));
  NodeAssertStrict.deepEqual(third.used(), { avrea: 15, blacksmith: 2 });
});

NodeTest.default("a dry run writes nothing, and --apply creates the variables when they are missing", () => {
  const options = () => ({ runs: [], variables: new Map() });
  const dry = createHarness(options());
  NodeAssertStrict.equal(main(["--repo", REPO], { gh: dry.gh, io: dry.io, now: NOW }), 0);
  NodeAssertStrict.deepEqual(dry.writes, []);
  NodeAssertStrict.ok(dry.stdout.includes("CI_RUNNER_POOL=avrea,blacksmith,github"));

  const applied = createHarness(options());
  NodeAssertStrict.equal(main(["--repo", REPO, "--apply"], { gh: applied.gh, io: applied.io, now: NOW }), 0);
  NodeAssertStrict.deepEqual(applied.writes, ["CI_RUNNER_USAGE", "CI_RUNNER_POOL"]);
  NodeAssertStrict.equal(applied.variables.get("CI_RUNNER_POOL"), "avrea,blacksmith,github");
});

NodeTest.default("starts a fresh tally in a new month but refuses a corrupt one", () => {
  const lastMonth = JSON.stringify({ month: "2026-10", used: { avrea: 2_900, blacksmith: 2_900 }, repos: { mcode: { maxId: 101 } } });
  const fresh = createHarness({ variables: new Map([["CI_RUNNER_USAGE", lastMonth]]) });
  NodeAssertStrict.equal(main(["--repo", REPO], { gh: fresh.gh, io: fresh.io, now: NOW }), 0);
  NodeAssertStrict.ok(fresh.stdout.includes("CI_RUNNER_POOL=avrea,blacksmith,github"));

  const corrupt = createHarness({ variables: new Map([["CI_RUNNER_USAGE", '{"oops":1}']]) });
  NodeAssertStrict.equal(main(["--repo", REPO, "--apply"], { gh: corrupt.gh, io: corrupt.io, now: NOW }), 1);
  NodeAssertStrict.deepEqual(corrupt.writes, []);
});

NodeTest.default("fails instead of undercounting when a window reaches GitHub's 1,000-run search limit", () => {
  const harness = createHarness({ runs: [{ id: 1, status: "completed", run_attempt: 1 }], total: 1_000 });
  NodeAssertStrict.equal(main(["--repo", REPO, "--apply"], { gh: harness.gh, io: harness.io, now: NOW }), 1);
  NodeAssertStrict.match(harness.stderr.join("\n"), /over 1000 runs/);
  NodeAssertStrict.deepEqual(harness.writes, []);
});
