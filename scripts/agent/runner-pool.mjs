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
 * unfinished, or re-run workflow runs.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

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
// windows short enough to stay under it.
const WINDOW_DAYS = 7;
const SEARCH_LIMIT = 1_000;

function defaultGh(args) {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  if (label.includes("macos")) {
    return { provider, weight: 20 }; // $0.08/min against $0.004/min
  }
  const vcpus = Number(label.match(/(\d+)-?vcpu/)?.[1] ?? 2);
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

function readVariable(gh, repo, name) {
  try {
    return JSON.parse(gh(["api", `repos/${repo}/actions/variables/${name}`])).value;
  } catch (error) {
    if (/HTTP 404/.test(String(error.stderr ?? error.message))) {
      return null;
    }
    throw error;
  }
}

function writeVariable(gh, repo, name, value) {
  try {
    gh(["api", "--method", "PATCH", `repos/${repo}/actions/variables/${name}`, "-f", `name=${name}`, "-f", `value=${value}`]);
  } catch (error) {
    if (!/HTTP 404/.test(String(error.stderr ?? error.message))) {
      throw error;
    }
    gh(["api", "--method", "POST", `repos/${repo}/actions/variables`, "-f", `name=${name}`, "-f", `value=${value}`]);
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

function listRuns(gh, org, repo, now) {
  const runs = [];
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  for (let start = monthStart; start <= now.getTime(); start += WINDOW_DAYS * 86_400_000) {
    const from = new Date(start).toISOString().slice(0, 10);
    const to = new Date(Math.min(start + (WINDOW_DAYS - 1) * 86_400_000, now.getTime())).toISOString().slice(0, 10);
    const rows = lines(gh([
      "api", "--paginate",
      `repos/${org}/${repo}/actions/runs?created=${from}..${to}&per_page=100`,
      "--jq", ".total_count as $total | .workflow_runs[] | {id, status, run_attempt, total: $total}",
    ]));
    if (rows.some((row) => row.total >= SEARCH_LIMIT)) {
      throw new Error(`${org}/${repo} has over ${SEARCH_LIMIT} runs between ${from} and ${to}; shorten WINDOW_DAYS.`);
    }
    runs.push(...rows);
  }
  return runs;
}

/**
 * Adds a repository's newly finished runs to the tally. A run counts once per
 * attempt: runs up to maxId are counted at attempt 1 unless they are pending
 * (seen unfinished) or listed in attempts (re-run).
 */
export function tallyRepo(gh, org, repo, repoState, used, now) {
  const maxId = repoState.maxId ?? 0;
  const pending = new Set(repoState.pending ?? []);
  const attempts = { ...repoState.attempts };
  const nextPending = [];
  let nextMaxId = maxId;

  for (const run of listRuns(gh, org, repo, now)) {
    nextMaxId = Math.max(nextMaxId, run.id);
    const counted = attempts[run.id] ?? (pending.has(run.id) || run.id > maxId ? 0 : 1);
    if (run.status !== "completed") {
      if (counted === 0) {
        nextPending.push(run.id);
      }
      continue;
    }
    if (run.run_attempt <= counted) {
      continue;
    }
    const jobs = lines(gh([
      "api", "--paginate",
      `repos/${org}/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
      "--jq", ".jobs[] | {labels, run_attempt, runner_name, started_at, completed_at}",
    ]));
    for (const job of jobs) {
      const target = classifyJob(job.labels);
      if (target && job.run_attempt > counted && job.runner_name && job.started_at && job.completed_at) {
        used[target.provider] = (used[target.provider] ?? 0) + billedMinutes(job) * target.weight;
      }
    }
    if (run.run_attempt > 1) {
      attempts[run.id] = run.run_attempt;
    }
  }
  return { maxId: nextMaxId, pending: nextPending, attempts };
}

/** Runs the runner-pool CLI with injectable GitHub, I/O and clock seams. */
export function main(argv, { gh = defaultGh, io = defaultIo(), now = new Date() } = {}) {
  try {
    const { repo, apply } = parseArguments(argv);
    const org = repo.split("/")[0];
    const state = loadState(readVariable(gh, repo, STATE_VARIABLE), now);
    const repos = lines(gh(["api", "--paginate", `orgs/${org}/repos?per_page=100`, "--jq", ".[] | select(.archived | not) | .name | tojson"]));
    for (const name of repos) {
      state.repos[name] = tallyRepo(gh, org, name, state.repos[name] ?? {}, state.used, now);
    }
    const pool = choosePool(state.used, now).join(",");

    for (const [provider, allowance] of Object.entries(ALLOWANCE)) {
      io.stdout(`${provider}: ${state.used[provider] ?? 0} of ${allowance} free minutes used in ${state.month}`);
    }
    io.stdout(`${POOL_VARIABLE}=${pool}`);
    if (!apply) {
      io.stdout("Dry run: no variables were written.");
      return 0;
    }
    writeVariable(gh, repo, STATE_VARIABLE, JSON.stringify(state));
    writeVariable(gh, repo, POOL_VARIABLE, pool);
    return 0;
  } catch (error) {
    io.stderr(`Runner pool update failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
