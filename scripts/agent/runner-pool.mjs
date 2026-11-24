#!/usr/bin/env bun
/**
 * Keeps CI inside each runner provider's free monthly minutes.
 *
 * Tallies this month's Avrea and Blacksmith minutes for the whole organization,
 * because both providers count free minutes per organization, then writes
 * CI_RUNNER_POOL: the providers the Pick Runner job in ci.yml may rotate across.
 * Neither provider has an API for remaining free minutes, so the tally comes
 * from GitHub's own job records. The tally is incremental: CI_RUNNER_USAGE keeps
 * the totals and which runs were already counted, so each pass reads only new,
 * unfinished, or re-run workflow runs. A pass that fails part way saves the runs
 * it finished, so a long backlog after an outage is read across passes.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// Free minutes a month, counted in 2 vCPU Linux x64 minutes. GitHub-hosted runners
// are absent on purpose: standard runners are free and unmetered for public repos.
export const ALLOWANCE = { avrea: 3_000, blacksmith: 3_000 };
// Leave each provider this many minutes before its allowance. Jobs that finish
// between two passes are not counted yet, and Avrea without a card cancels new
// jobs once the free minutes run out, which fails the PR check.
export const SAFETY_MARGIN = 300;
const POOL_ORDER = ["avrea", "blacksmith", "github"];
const STATE_VARIABLE = "CI_RUNNER_USAGE";
const POOL_VARIABLE = "CI_RUNNER_POOL";
// GitHub returns at most 1,000 runs for a filtered query, so runs are listed in
// week-long windows, and a window that reaches the limit is split in half.
const WINDOW_DAYS = 7;
const SEARCH_LIMIT = 1_000;
const DAY_MS = 86_400_000;
// Job records are read this many runs at a time. Higher counts risk GitHub's
// secondary rate limit of 900 read requests a minute.
const JOB_FETCH_CONCURRENCY = 6;
// A pass makes about one request per new run, so after an outage it makes
// hundreds, and one 502 used to throw all of them away.
const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];
const TRANSIENT_ERROR = /HTTP (5\d\d|429)|secondary rate limit|ECONNRESET|ETIMEDOUT|unexpected EOF/i;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function defaultGh(args) {
  const { stdout } = await execFile("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Wraps a gh caller so transient GitHub failures are retried with backoff. */
function retrying(gh, sleep, io) {
  return async (args) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await gh(args);
      } catch (error) {
        const detail = String(error.stderr ?? error.message);
        if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT_ERROR.test(detail)) {
          throw error;
        }
        io.stderr(`Retrying gh ${args.find((arg) => /^(repos|orgs)\//.test(arg))} after: ${detail.trim().split("\n")[0]}`);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  };
}

function defaultIo() {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  };
}

function parseArguments(argv) {
  const parsed = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      parsed.apply = true;
    } else if (argument === "--repo") {
      parsed.repo = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(parsed.repo ?? "")) {
    throw new Error("--repo must be an owner/name pair.");
  }
  return parsed;
}

/**
 * Returns the provider a job ran on and how many 2 vCPU Linux minutes each of
 * its minutes costs, or null for GitHub-hosted and self-hosted jobs. Weights
 * follow Avrea's published prices, which draw free minutes in proportion to
 * price. Blacksmith does not say how it weights free minutes, so it gets the
 * same weights, which never undercount its own price ratios.
 */
export function classifyJob(labels) {
  const label = labels.find((name) => /^(avrea|blacksmith)-/.test(name));
  if (!label) {
    return null;
  }
  const provider = label.slice(0, label.indexOf("-"));
  const vcpus = Number(label.match(/(\d+)-?vcpu/)?.[1] ?? 2);
  if (label.includes("macos")) {
    // $0.08/min for up to 8 vCPU against $0.004/min; Avrea's 16 vCPU is $0.16/min.
    return { provider, weight: 20 * Math.max(1, vcpus / 8) };
  }
  let weight = Math.max(1, vcpus / 2);
  if (label.includes("windows")) {
    weight *= 2; // $0.008/min for 2 vCPU Windows
  } else if (provider === "avrea" && label.includes("arm")) {
    weight *= 3; // $0.012/min for 2 vCPU Avrea ARM
  }
  return { provider, weight };
}

/** Rounds a job's run time up to whole minutes, the way providers bill. */
export function billedMinutes(job) {
  const seconds = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1_000;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * Picks the providers CI may use now. A provider stays in while its usage is
 * under today's even share of its allowance and under the safety margin, so
 * free minutes last the whole month. GitHub is always in, so a job always has
 * a runner.
 */
export function choosePool(used, now) {
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const pool = Object.entries(ALLOWANCE)
    .filter(([provider, allowance]) => {
      const limit = Math.min((allowance * day) / daysInMonth, allowance - SAFETY_MARGIN);
      return (used[provider] ?? 0) < limit;
    })
    .map(([provider]) => provider);
  return POOL_ORDER.filter((provider) => provider === "github" || pool.includes(provider));
}

function monthOf(now) {
  return now.toISOString().slice(0, 7);
}

function emptyState(month) {
  return { month, used: { avrea: 0, blacksmith: 0 }, repos: {} };
}

async function readVariable(gh, repo, name) {
  try {
    return JSON.parse(await gh(["api", `repos/${repo}/actions/variables/${name}`])).value;
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr ?? error.message))) {
      return null;
    }
    throw error;
  }
}

async function writeVariable(gh, repo, name, value) {
  try {
    await gh(["api", "--method", "PATCH", `repos/${repo}/actions/variables/${name}`, "-f", `name=${name}`, "-f", `value=${value}`]);
  } catch (error) {
    if (!/HTTP 404/.test(String(error.stderr ?? error.message))) {
      throw error;
    }
    await gh(["api", "--method", "POST", `repos/${repo}/actions/variables`, "-f", `name=${name}`, "-f", `value=${value}`]);
  }
}

/** Loads the saved tally, starting fresh in a new month. A corrupt tally is an error, not a reset, because a reset would undercount. */
export function loadState(raw, now) {
  const month = monthOf(now);
  if (raw === null) {
    return emptyState(month);
  }
  const state = JSON.parse(raw);
  if (typeof state?.month !== "string" || typeof state.used !== "object" || typeof state.repos !== "object") {
    throw new Error(`${STATE_VARIABLE} does not hold a runner tally.`);
  }
  return state.month === month ? state : emptyState(month);
}

function lines(output) {
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function isoDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

async function listRuns(gh, org, repo, now) {
  const runs = [];
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let start = monthStart; start <= today; start += WINDOW_DAYS * DAY_MS) {
    const last = Math.min(start + (WINDOW_DAYS - 1) * DAY_MS, today);
    runs.push(...(await listWindow(gh, `${org}/${repo}`, start, last)));
  }
  return runs;
}

/** Lists the runs created from day `first` to day `last`, halving the range while it reaches the search limit. */
async function listWindow(gh, repo, first, last) {
  const from = isoDay(first);
  const to = isoDay(last);
  const rows = lines(await gh([
    "api", "--paginate",
    `repos/${repo}/actions/runs?created=${from}..${to}&per_page=100`,
    "--jq", ".total_count as $total | .workflow_runs[] | {id, status, run_attempt, total: $total}",
  ]));
  if (!rows.some((row) => row.total >= SEARCH_LIMIT)) {
    return rows;
  }
  if (first === last) {
    throw new Error(`${repo} has over ${SEARCH_LIMIT} runs on ${from}, more than GitHub's run search can list.`);
  }
  const middle = first + Math.floor((last - first) / DAY_MS / 2) * DAY_MS;
  return [...(await listWindow(gh, repo, first, middle)), ...(await listWindow(gh, repo, middle + DAY_MS, last))];
}

/**
 * Adds a repository's newly finished runs to `state`. A run counts once per
 * attempt: runs up to maxId are counted at attempt 1 unless they are pending
 * (seen unfinished) or listed in attempts (re-run). Runs are applied in id
 * order and the repository's entry is rewritten even when a run fails, so the
 * entry always holds every run before the failure and none after it.
 */
export async function tallyRepo(gh, org, repo, state, now) {
  const tally = createRepoTally(state.repos[repo] ?? {});
  // Runs with nothing new are at or below maxId, so skipping them leaves maxId where a full walk would.
  const work = (await listRuns(gh, org, repo, now))
    .map((run) => ({ ...run, counted: tally.counted(run.id) }))
    .filter((run) => (run.status === "completed" ? run.run_attempt > run.counted : run.counted === 0))
    .sort((left, right) => left.id - right.id);

  try {
    for (let index = 0; index < work.length; index += JOB_FETCH_CONCURRENCY) {
      const batch = work.slice(index, index + JOB_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(batch.map((run) => readRunMinutes(gh, `repos/${org}/${repo}`, run)));
      for (const [position, run] of batch.entries()) {
        tally.apply(run, settledValue(results[position]), state.used);
      }
    }
    tally.dropUnvisitedPending();
  } finally {
    state.repos[repo] = tally.entry();
  }
}

/** Tracks one repository's tally entry while its runs are applied in id order. */
function createRepoTally(saved) {
  const seen = { maxId: saved.maxId ?? 0, pending: new Set(saved.pending ?? []), attempts: saved.attempts ?? {} };
  const attempts = { ...seen.attempts };
  // Earlier pending runs are at or below maxId, so they stay listed until visited, or they would read as counted.
  const unvisitedPending = new Set(seen.pending);
  const pending = [];
  let maxId = seen.maxId;
  return {
    counted: (runId) => countedAttempts(runId, seen),
    /** Records a run whose minutes are null while it is unfinished. */
    apply(run, minutes, used) {
      if (minutes === null) {
        pending.push(run.id);
      } else {
        addMinutes(used, minutes);
        if (run.run_attempt > 1) {
          attempts[run.id] = run.run_attempt;
        }
      }
      unvisitedPending.delete(run.id);
      maxId = Math.max(maxId, run.id);
    },
    /** Pending runs no longer listed were deleted, so a finished walk drops them. */
    dropUnvisitedPending: () => unvisitedPending.clear(),
    entry: () => ({ maxId, pending: [...pending, ...unvisitedPending], attempts }),
  };
}

function settledValue(result) {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}

function addMinutes(used, minutes) {
  for (const [provider, amount] of Object.entries(minutes)) {
    used[provider] = (used[provider] ?? 0) + amount;
  }
}

/** Reads a finished run's new provider minutes, or returns null for an unfinished run. */
async function readRunMinutes(gh, repoEndpoint, run) {
  return run.status === "completed" ? runMinutes(gh, `${repoEndpoint}/actions/runs/${run.id}`, run.counted) : null;
}

/** How many attempts of a run the tally already holds. */
function countedAttempts(runId, { maxId, pending, attempts }) {
  if (attempts[runId] !== undefined) {
    return attempts[runId];
  }
  return pending.has(runId) || runId > maxId ? 0 : 1;
}

/** Returns each provider's minutes from a run's jobs in attempts after `counted`. */
async function runMinutes(gh, runEndpoint, counted) {
  const jobs = lines(await gh([
    "api", "--paginate",
    `${runEndpoint}/jobs?filter=all&per_page=100`,
    "--jq", ".jobs[] | {labels, run_attempt, runner_name, started_at, completed_at}",
  ]));
  const minutes = {};
  for (const job of jobs) {
    const target = classifyJob(job.labels);
    if (target && job.run_attempt > counted && ranOnRunner(job)) {
      minutes[target.provider] = (minutes[target.provider] ?? 0) + billedMinutes(job) * target.weight;
    }
  }
  return minutes;
}

/** A job that never reached a runner, such as a skipped one, used no minutes. */
function ranOnRunner(job) {
  return Boolean(job.runner_name && job.started_at && job.completed_at);
}

function printTally(io, state, pool) {
  for (const [provider, allowance] of Object.entries(ALLOWANCE)) {
    io.stdout(`${provider}: ${state.used[provider] ?? 0} of ${allowance} free minutes used in ${state.month}`);
  }
  io.stdout(`${POOL_VARIABLE}=${pool}`);
}

/**
 * Saves a partial tally after a failed pass. The pool is left alone, because a
 * partial tally undercounts and could readmit a provider that is out of minutes.
 */
async function saveProgress(gh, io, repo, state) {
  try {
    await writeVariable(gh, repo, STATE_VARIABLE, JSON.stringify(state));
    io.stderr(`Saved the runs tallied before the failure below; the next pass continues from them. ${POOL_VARIABLE} is unchanged.`);
  } catch (error) {
    io.stderr(`Could not save the tally so far: ${error.message}`);
  }
}

/** Adds every active organization repository's new runs to `state`, saving partial progress if one fails. */
async function tallyOrganization(gh, io, { repo, apply }, state, now) {
  const org = repo.split("/")[0];
  const loaded = JSON.stringify(state);
  try {
    const repos = lines(await gh(["api", "--paginate", `orgs/${org}/repos?per_page=100`, "--jq", ".[] | select(.archived | not) | .name | tojson"]));
    for (const name of repos) {
      await tallyRepo(gh, org, name, state, now);
    }
  } catch (error) {
    if (apply && JSON.stringify(state) !== loaded) {
      await saveProgress(gh, io, repo, state);
    }
    throw error;
  }
}

/** Runs the runner-pool CLI with injectable GitHub, I/O, clock and sleep seams. */
export async function main(argv, { gh = defaultGh, io = defaultIo(), now = new Date(), sleep = defaultSleep } = {}) {
  const call = retrying(gh, sleep, io);
  try {
    const options = parseArguments(argv);
    const state = loadState(await readVariable(call, options.repo, STATE_VARIABLE), now);
    await tallyOrganization(call, io, options, state, now);
    const pool = choosePool(state.used, now).join(",");
    printTally(io, state, pool);
    if (!options.apply) {
      io.stdout("Dry run: no variables were written.");
      return 0;
    }
    await writeVariable(call, options.repo, STATE_VARIABLE, JSON.stringify(state));
    await writeVariable(call, options.repo, POOL_VARIABLE, pool);
    return 0;
  } catch (error) {
    io.stderr(`Runner pool update failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
