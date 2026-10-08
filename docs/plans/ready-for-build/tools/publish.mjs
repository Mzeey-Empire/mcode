// Publish the Ready for build program to GitHub issues. Kept for the audit trail.
//
//   RFB_REF=<pushed commit sha> node tools/publish.mjs
//
// Resumable: issue numbers go to tools/issue-map.json and finished links to
// tools/publish-state.json, so a rerun skips what already exists. Before every
// create it looks for an issue the same account already opened with the exact
// title, so a create whose response was lost is never duplicated.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const graph = JSON.parse(readFileSync(join(here, "graph.json"), "utf8"));
const mapPath = join(here, "issue-map.json");
const statePath = join(here, "publish-state.json");
const numbers = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { done: [] };
const done = new Set(state.done);

if (!process.env.RFB_REF || !/^[0-9a-f]{40}$/.test(process.env.RFB_REF)) {
  throw new Error("Set RFB_REF to the full SHA of the pushed commit the issue links should pin to.");
}

const PACE_MS = 2500;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const save = () => {
  writeFileSync(mapPath, `${JSON.stringify(numbers, null, 2)}\n`);
  writeFileSync(statePath, `${JSON.stringify({ done: [...done] }, null, 2)}\n`);
};

function gh(args, { write = true } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const run = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (run.status === 0) {
      if (write) sleep(PACE_MS);
      return run.stdout.trim();
    }
    const err = `${run.stderr}${run.stdout}`;
    // GitHub's secondary limits cap content creation per minute and per hour; wait them out.
    const limited = /rate limit|abuse|secondary|HTTP 403|HTTP 429|was submitted too quickly/i.test(err);
    if (!limited || attempt > 12) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${err.trim()}`);
    const wait = Math.min(60_000 * attempt, 600_000);
    console.log(`rate limited, waiting ${wait / 1000}s (attempt ${attempt})`);
    sleep(wait);
  }
}

const login = gh(["api", "user", "-q", ".login"], { write: false });

function findExisting(title) {
  const out = gh(["api", `repos/{owner}/{repo}/issues?creator=${login}&state=all&sort=created&direction=desc&per_page=100`, "-q", `.[] | select(.title == ${JSON.stringify(title)}) | .number`], { write: false });
  return out ? Number(out.split("\n")[0]) : null;
}

function regenerate() {
  const run = spawnSync("node", [join(here, "graph.mjs"), "issues"], { encoding: "utf8", env: process.env });
  if (run.status !== 0) throw new Error(`graph.mjs issues failed: ${run.stderr}`);
}

function create(key, title, bodyFile, labels) {
  if (numbers[key]) return numbers[key];
  const existing = findExisting(title);
  if (existing) {
    numbers[key] = existing;
  } else {
    const url = gh(["issue", "create", "--title", title, "--body-file", bodyFile, ...labels.flatMap((l) => ["--label", l])]);
    numbers[key] = Number(url.split("/").pop());
  }
  save();
  console.log(`${key} -> #${numbers[key]}`);
  return numbers[key];
}

function edit(number, bodyFile) {
  gh(["issue", "edit", String(number), "--body-file", bodyFile]);
}

const nodeIds = new Map();
function nodeId(number) {
  if (!nodeIds.has(number)) nodeIds.set(number, gh(["api", `repos/{owner}/{repo}/issues/${number}`, "-q", ".node_id"], { write: false }));
  return nodeIds.get(number);
}
const restIds = new Map();
function restId(number) {
  if (!restIds.has(number)) restIds.set(number, gh(["api", `repos/{owner}/{repo}/issues/${number}`, "-q", ".id"], { write: false }));
  return restIds.get(number);
}

function linkSubIssue(parent, child) {
  const key = `sub:${parent}:${child}`;
  if (done.has(key)) return;
  const current = spawnSync("gh", ["api", `repos/{owner}/{repo}/issues/${child}/parent`, "-q", ".number"], { encoding: "utf8" });
  if (current.status !== 0 || current.stdout.trim() !== String(parent)) {
    gh(["api", "graphql", "-H", "GraphQL-Features: sub_issues", "-f", "query=mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}", "-f", `p=${nodeId(parent)}`, "-f", `c=${nodeId(child)}`]);
  }
  done.add(key);
  save();
}

function linkBlockedBy(blocked, blocker) {
  const key = `blk:${blocked}:${blocker}`;
  if (done.has(key)) return;
  const existing = gh(["api", `repos/{owner}/{repo}/issues/${blocked}/dependencies/blocked_by`, "-q", ".[].number"], { write: false });
  if (!existing.split("\n").includes(String(blocker))) {
    gh(["api", "--method", "POST", `repos/{owner}/{repo}/issues/${blocked}/dependencies/blocked_by`, "-F", `issue_id=${restId(blocker)}`]);
  }
  done.add(key);
  save();
}

// Waves order tickets so every blocker exists before the ticket that cites it.
function wavesInOrder() {
  const memo = new Map();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    const list = graph.blockers[id][0] === "*" ? [] : graph.blockers[id];
    const d = list.length ? 1 + Math.max(...list.map(depth)) : 0;
    memo.set(id, d);
    return d;
  };
  const ids = Object.keys(graph.blockers);
  const star = ids.filter((id) => graph.blockers[id][0] === "*");
  const rest = ids.filter((id) => !star.includes(id)).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b, "en", { numeric: true }));
  return [...rest, ...star];
}

// The sweep ticket waits on everything; natively it is blocked by the tickets nothing else waits on.
function sinkTickets() {
  const ids = Object.keys(graph.blockers).filter((id) => graph.blockers[id][0] !== "*");
  const blocking = new Set(ids.flatMap((id) => graph.blockers[id]));
  return ids.filter((id) => !blocking.has(id));
}

const out = join(here, "out");
const sectionEntries = Object.entries(graph.sections);

regenerate();
const program = create("epic:program", "epic: Ready for build, Paper sections 01 to 12", join(out, "epic-program.md"), ["epic"]);
regenerate();
create("epic:scoping:model-picker", "epic: Model picker extras (needs scoping)", join(out, "epic-scoping-model-picker.md"), ["epic"]);
create("epic:scoping:projectless-chat", "epic: Start a chat without a project (needs scoping)", join(out, "epic-scoping-projectless-chat.md"), ["epic"]);
regenerate();
sectionEntries.forEach(([, { epic }], index) => {
  const number = create(`epic:${epic}`, `epic: Ready for build · ${epic}`, join(out, `epic-${String(index).padStart(2, "0")}.md`), ["epic"]);
  linkSubIssue(program, number);
});

const titles = JSON.parse(spawnSync("node", [join(here, "graph.mjs"), "titles"], { encoding: "utf8" }).stdout);

for (const id of wavesInOrder()) {
  if (!numbers[id]) regenerate();
  const { file, title } = titles[id];
  const number = create(id, `feat(${id}): ${title}`, join(out, `${id}.md`), ["feat", "ready-for-agent"]);
  linkSubIssue(numbers[`epic:${graph.sections[file].epic}`], number);
  if (graph.blockers[id][0] !== "*") {
    for (const b of graph.blockers[id]) linkBlockedBy(number, numbers[b]);
    continue;
  }
  try {
    for (const b of sinkTickets()) linkBlockedBy(number, numbers[b]);
  } catch (error) {
    // If GitHub caps blocked-by links per issue, the sweep waits on the other section epics instead.
    console.log(`sink links stopped (${error.message}); linking section epics instead`);
    for (const [file, { epic }] of sectionEntries) if (file !== titles[id].file) linkBlockedBy(number, numbers[`epic:${epic}`]);
  }
}

// Second pass: epic bodies list their tickets' numbers, which exist only now.
regenerate();
if (!done.has("bodies:epics")) {
  edit(program, join(out, "epic-program.md"));
  sectionEntries.forEach(([, { epic }], index) => edit(numbers[`epic:${epic}`], join(out, `epic-${String(index).padStart(2, "0")}.md`)));
  done.add("bodies:epics");
  save();
}
console.log(`published: ${Object.keys(numbers).length} issues`);
