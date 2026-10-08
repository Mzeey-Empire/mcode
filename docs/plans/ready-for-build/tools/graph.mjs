// Ticket graph for the Ready for build program.
// graph.json is the single source of truth for ticket ids, blockers and
// reconciliation notes; the section docs hold each ticket's body.
//
//   node graph.mjs check        validate ids, blockers, cycles; print waves
//   node graph.mjs sync-docs    rewrite each ticket's "Blocked by" line in the section docs
//   node graph.mjs render       write ../tickets.md
//   node graph.mjs issues       write issue bodies to ./out/<id>.md (needs ./issue-map.json for numbers, optional)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sectionsDir = join(root, "sections");
const graph = JSON.parse(readFileSync(join(here, "graph.json"), "utf8"));
// Issue links pin to the published commit (RFB_REF=<sha>) so they survive later edits and branch deletion.
const REPO_BLOB = `https://github.com/Mzeey-Empire/mcode/blob/${process.env.RFB_REF ?? "docs/app-page-map"}/docs/plans/ready-for-build`;

const HEADING = /^### ((?:F|S\d{2}[A-Z]?)-\d{2}[a-z]?|F-\d{2}[a-z]?)\b\s*(.*)$/;

function loadSections() {
  const tickets = new Map();
  for (const file of Object.keys(graph.sections)) {
    const lines = readFileSync(join(sectionsDir, file), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = HEADING.exec(line);
      if (!match) return;
      const [, id, rawTitle] = match;
      if (tickets.has(id) && tickets.get(id).file !== file) {
        // F-05 is listed as a stub in 00 and specified in 12b; the full spec wins.
        if (file.startsWith("00-")) return;
      }
      if (tickets.has(id) && file.startsWith("00-") === false && tickets.get(id).file.startsWith("00-") === false) {
        throw new Error(`Duplicate heading ${id} in ${file} and ${tickets.get(id).file}`);
      }
      tickets.set(id, { id, title: cleanTitle(rawTitle), file, line: index });
    });
  }
  return tickets;
}

function cleanTitle(title) {
  return title.replace(/\s*\((?:section 12 owns|prefactor)\)\s*$/i, "").trim();
}

function allIds() {
  return Object.keys(graph.blockers);
}

function resolvedBlockers(id) {
  const list = graph.blockers[id];
  if (list.length === 1 && list[0] === "*") return allIds().filter((other) => other !== id);
  return list;
}

function check() {
  const tickets = loadSections();
  const problems = [];
  for (const id of tickets.keys()) {
    if (!(id in graph.blockers) && !(id in graph.dropped)) problems.push(`Heading ${id} (${tickets.get(id).file}) missing from graph.json`);
  }
  for (const id of allIds()) {
    if (!tickets.has(id)) problems.push(`graph.json id ${id} has no heading in any section doc`);
    for (const blocker of resolvedBlockers(id)) {
      if (blocker in graph.dropped) problems.push(`${id} is blocked by dropped ticket ${blocker}`);
      else if (!(blocker in graph.blockers)) problems.push(`${id} is blocked by unknown ticket ${blocker}`);
    }
  }
  const waves = computeWaves(problems);
  return { tickets, waves, problems };
}

function computeWaves(problems) {
  const wave = new Map();
  const visiting = new Set();
  const visit = (id, trail) => {
    if (wave.has(id)) return wave.get(id);
    if (visiting.has(id)) {
      problems.push(`Cycle: ${[...trail, id].join(" -> ")}`);
      return 0;
    }
    visiting.add(id);
    const blockers = resolvedBlockers(id).filter((b) => b in graph.blockers);
    const level = blockers.length === 0 ? 1 : 1 + Math.max(...blockers.map((b) => visit(b, [...trail, id])));
    visiting.delete(id);
    wave.set(id, level);
    return level;
  };
  for (const id of allIds()) visit(id, []);
  return wave;
}

function sectionOf(id, tickets) {
  return tickets.get(id)?.file;
}

function syncDocs(tickets) {
  for (const file of Object.keys(graph.sections)) {
    const path = join(sectionsDir, file);
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    let current = null;
    for (let i = 0; i < lines.length; i += 1) {
      const match = HEADING.exec(lines[i]);
      if (match) {
        current = match[1];
        if (current in graph.dropped && !lines[i].includes("(merged)")) lines[i] = `${lines[i]} (merged)`;
        continue;
      }
      if (!current || !lines[i].startsWith("- **Blocked by:**")) continue;
      if (current in graph.dropped) {
        lines[i] = `- **Blocked by:** Not a ticket. ${graph.dropped[current]}`;
      } else if (current in graph.blockers && sectionOf(current, tickets) === file) {
        const blockers = resolvedBlockers(current);
        const text = graph.blockers[current][0] === "*"
          ? "Every other ticket in this program (see tickets.md)."
          : blockers.length === 0 ? "None (can start immediately)." : blockers.map((b) => `${b} ${tickets.get(b)?.title ?? ""}`.trim()).join("; ") + ".";
        lines[i] = `- **Blocked by:** ${text}`;
        const note = graph.notes[current];
        const decision = graph.needsDecision[current];
        const extra = [];
        if (note) extra.push(`- **Reconciled:** ${note}`);
        if (decision) extra.push(`- **Needs decision:** ${decision}`);
        let j = i + 1;
        while (j < lines.length && (lines[j].startsWith("- **Reconciled:**") || lines[j].startsWith("- **Needs decision:**"))) j += 1;
        lines.splice(i + 1, j - (i + 1), ...extra);
      }
      current = null;
    }
    writeFileSync(path, lines.join("\n"));
  }
}

function render(tickets, waves) {
  const byWave = new Map();
  for (const id of allIds()) {
    const level = waves.get(id);
    if (!byWave.has(level)) byWave.set(level, []);
    byWave.get(level).push(id);
  }
  const out = [];
  out.push("# Ticket graph");
  out.push("");
  out.push("Generated by `tools/graph.mjs render` from `tools/graph.json`. Do not edit by hand; edit the JSON and rerun.");
  out.push("");
  out.push(`${allIds().length} tickets across ${Object.keys(graph.sections).length} epics. A ticket can start when every ticket it is blocked by has merged. Wave N holds tickets whose longest blocker chain is N-1 long, so every ticket in a wave can run in parallel once the earlier waves are done.`);
  out.push("");
  for (const level of [...byWave.keys()].sort((a, b) => a - b)) {
    out.push(`## Wave ${level}`);
    out.push("");
    out.push("| Ticket | Title | Epic | Blocked by |");
    out.push("|---|---|---|---|");
    for (const id of byWave.get(level).sort(compareIds)) {
      const t = tickets.get(id);
      const blockers = graph.blockers[id][0] === "*" ? "every other ticket" : resolvedBlockers(id).join(", ") || "None";
      const flag = graph.needsDecision[id] ? " (needs decision)" : "";
      out.push(`| [${id}](sections/${t.file}) | ${t.title}${flag} | ${graph.sections[t.file].epic} | ${blockers} |`);
    }
    out.push("");
  }
  out.push("## Merged tickets");
  out.push("");
  for (const [id, why] of Object.entries(graph.dropped)) out.push(`- ${id}: ${why}`);
  out.push("");
  out.push("## Reconciliation notes");
  out.push("");
  for (const [id, note] of Object.entries(graph.notes)) out.push(`- **${id}.** ${note}`);
  out.push("");
  out.push("## Waiting on a decision");
  out.push("");
  for (const [id, why] of Object.entries(graph.needsDecision)) out.push(`- **${id}.** ${why}`);
  out.push("");
  writeFileSync(join(root, "tickets.md"), out.join("\n"));
}

function compareIds(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

function ticketBody(id, tickets) {
  const t = tickets.get(id);
  const lines = readFileSync(join(sectionsDir, t.file), "utf8").split(/\r?\n/);
  const body = [];
  for (let i = t.line + 1; i < lines.length; i += 1) {
    if (/^#{1,3} /.test(lines[i])) break;
    // The issue's own "Blocked by" section carries real issue numbers.
    if (lines[i].startsWith("- **Blocked by:**")) continue;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

// GitHub's heading anchor: lowercase, drop punctuation except hyphens and spaces, spaces to hyphens.
function githubAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const PAPER_PAGE = "https://app.paper.design/file/01M3V9R04VVSFTYQ76BRHHA83K/p-6-0";

function issues(tickets) {
  const mapPath = join(here, "issue-map.json");
  const numbers = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
  const ref = (id) => (numbers[id] ? `#${numbers[id]} (${id})` : id);
  const outDir = join(here, "out");
  mkdirSync(outDir, { recursive: true });
  for (const id of allIds()) {
    const t = tickets.get(id);
    const headingLine = readFileSync(join(sectionsDir, t.file), "utf8").split(/\r?\n/)[t.line].replace(/^### /, "");
    const anchor = `${REPO_BLOB}/sections/${t.file}#${githubAnchor(headingLine)}`;
    const blockers = graph.blockers[id][0] === "*" ? ["every other ticket in the program"] : resolvedBlockers(id).map(ref);
    const epicKey = graph.sections[t.file].epic;
    const parts = [
      "## Parent",
      "",
      numbers[`epic:${epicKey}`] ? `#${numbers[`epic:${epicKey}`]}` : epicKey,
      "",
      "## What to build",
      "",
      `Full brief: [${t.file} → ${id}](${anchor}). Read the section's Locked decisions, Backend architecture and Retirement ledger before coding. Program rules: [README](${REPO_BLOB}/README.md). Open questions and defaults: [decisions.md](${REPO_BLOB}/decisions.md). Boards: [Paper · 05 Ready for build](${PAPER_PAGE}); open a board by its node id with the Paper MCP tools.`,
      "",
      ...(graph.needsDecision[id] ? [`> **Needs decision before build:** ${graph.needsDecision[id]}`, ""] : []),
      ticketBody(id, tickets),
      "",
      "## Blocked by",
      "",
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- None (can start immediately)"]),
      "",
    ];
    writeFileSync(join(outDir, `${id}.md`), parts.join("\n"));
  }
}

function sectionIntro(file) {
  const lines = readFileSync(join(sectionsDir, file), "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith("# ")) + 1;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end).join("\n").trim();
}

function epics(tickets, waves) {
  const mapPath = join(here, "issue-map.json");
  const numbers = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, "utf8")) : {};
  const ref = (id) => (numbers[id] ? `#${numbers[id]}` : id);
  const outDir = join(here, "out");
  mkdirSync(outDir, { recursive: true });
  const program = numbers["epic:program"] ? `#${numbers["epic:program"]}` : "the program epic";

  Object.entries(graph.sections).forEach(([file, { epic }], index) => {
    const ids = allIds().filter((id) => tickets.get(id).file === file).sort(compareIds);
    const byWave = new Map();
    for (const id of ids) {
      const w = waves.get(id);
      if (!byWave.has(w)) byWave.set(w, []);
      byWave.get(w).push(id);
    }
    const sequence = [];
    [...byWave.keys()].sort((a, b) => a - b).forEach((w, i) => {
      if (i > 0) sequence.push("  ↓");
      const row = byWave.get(w);
      sequence.push(row.length > 1 ? `${row.join(" ←→ ")}  (wave ${w}, can parallel)` : `${row[0]}  (wave ${w})`);
    });
    const external = new Set();
    for (const id of ids) for (const b of resolvedBlockers(id)) if (graph.blockers[id][0] !== "*" && tickets.get(b).file !== file) external.add(b);
    const body = [
      "## Parent",
      "",
      program,
      "",
      "## Description",
      "",
      sectionIntro(file),
      "",
      `Full brief: [sections/${file}](${REPO_BLOB}/sections/${file}). Program README: [README](${REPO_BLOB}/README.md).`,
      "",
      "## Sequencing",
      "",
      "```",
      ...sequence,
      "```",
      "",
      "Waves are program-wide (see tickets.md); a ticket starts when all its blockers have merged.",
      "",
      ...(external.size ? ["## Blocked by tickets in other epics", "", ...[...external].sort(compareIds).map((b) => `- ${numbers[b] ? `#${numbers[b]} ` : ""}${b} ${tickets.get(b).title}`), ""] : []),
      "## Tickets",
      "",
      ...ids.map((id) => `- [ ] ${numbers[id] ? `#${numbers[id]} ` : ""}${id} ${tickets.get(id).title}`),
      "",
    ];
    writeFileSync(join(outDir, `epic-${String(index).padStart(2, "0")}.md`), body.join("\n"));
  });

  const spec = readFileSync(join(root, "spec.md"), "utf8").replace(/^# .*\n/, "");
  const programBody = [
    "Build the Paper \"05 · Ready for build\" screens, sections 01 to 12, with the backend they need.",
    "",
    `Program README: [README](${REPO_BLOB}/README.md) · Ticket graph: [tickets.md](${REPO_BLOB}/tickets.md) · Open decisions: [decisions.md](${REPO_BLOB}/decisions.md) · Boards: [Paper · 05 Ready for build](${PAPER_PAGE})`,
    "",
    "## Epics",
    "",
    ...Object.values(graph.sections).map(({ epic }) => `- [ ] ${numbers[`epic:${epic}`] ? `#${numbers[`epic:${epic}`]} ` : ""}${epic}`),
    "",
    "## Sequencing",
    "",
    "```",
    "Foundation tokens (F-01a → F-01b) and wave-1 backend prefactors",
    "  ↓",
    "Primitives F-02..F-12  ←→  section backends (approval v2, attention, plan record, revert, roster, files, comparisons) - can parallel",
    "  ↓",
    "F-05 panel shell  ←→  sidebar row model  ←→  overview card shell - can parallel",
    "  ↓",
    "Section UI slices per epic - can parallel across epics",
    "  ↓",
    "F-99 dead code sweep",
    "```",
    "",
    spec.trim(),
    "",
  ];
  writeFileSync(join(outDir, "epic-program.md"), programBody.join("\n"));
}

// Retirement ledger rows: | Remove | Where | Replaced by | Deleted in ticket | Proof it is gone |
const ID_PATTERN = /\b(?:F-\d{2}[a-z]?|S\d{2}[A-Z]?-\d{2})\b/g;
// Proofs run without a shell so they behave the same on Windows, macOS and Linux:
// `rg` passes when it prints nothing; `bun`, `node` and `git` pass on exit 0.
const PROOF_RUNNERS = ["rg", "bun", "node", "git"];
const PROOF_COMMAND = /`((?:rg|bun|node|git)\s[^`]*)`/;

function proofCommands(proofCell) {
  return [...proofCell.matchAll(/`([^`]*)`/g)]
    .map((m) => m[1].replace(/\\\|/g, "|"))
    .filter((cmd) => PROOF_RUNNERS.includes(cmd.split(/\s/)[0]));
}

// Minimal POSIX-style word splitting: double quotes (with \" and \\ escapes) and single quotes.
// Returns null when the command uses shell operators, which proofs must not need.
function splitWords(cmd) {
  const words = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (ch === '"') {
      inWord = true;
      for (i += 1; i < cmd.length && cmd[i] !== '"'; i += 1) {
        if (cmd[i] === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) i += 1;
        word += cmd[i];
      }
    } else if (ch === "'") {
      inWord = true;
      for (i += 1; i < cmd.length && cmd[i] !== "'"; i += 1) word += cmd[i];
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else if ("|&;<>".includes(ch)) {
      return null;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

function ledgerRows() {
  const rows = [];
  for (const file of Object.keys(graph.sections)) {
    const lines = readFileSync(join(sectionsDir, file), "utf8").split(/\r?\n/);
    let inLedger = false;
    lines.forEach((line, index) => {
      if (/^### Retirement ledger/.test(line)) { inLedger = true; return; }
      if (inLedger && /^#/.test(line)) { inLedger = false; return; }
      if (!inLedger || !line.startsWith("|") || /^\|\s*(Remove|---)/.test(line)) return;
      // Split on unescaped pipes; "\|" is a literal pipe inside a cell.
      const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
      rows.push({ file, line: index + 1, remove: cells[0], owner: cells[3] ?? "", proof: cells[4] ?? "" });
    });
  }
  return rows;
}

function ledgerCheck() {
  const problems = [];
  for (const row of ledgerRows()) {
    const owners = [...new Set(row.owner.match(ID_PATTERN) ?? [])];
    const where = `${row.file}:${row.line}`;
    if (owners.length !== 1) problems.push(`${where} needs exactly one owning ticket, found ${owners.length ? owners.join(", ") : "none"}`);
    for (const owner of owners) {
      if (owner in graph.dropped) problems.push(`${where} owner ${owner} was merged; ${graph.dropped[owner]}`);
      else if (!(owner in graph.blockers)) problems.push(`${where} owner ${owner} is not a ticket`);
    }
    if (!PROOF_COMMAND.test(row.proof)) problems.push(`${where} proof is not a runnable command: ${row.proof.slice(0, 80)}`);
    for (const cmd of proofCommands(row.proof)) {
      if (!splitWords(cmd)) problems.push(`${where} proof uses a shell operator (pipe, &&, ;, redirect); split it into separate commands: ${cmd.slice(0, 80)}`);
    }
  }
  return problems;
}

async function ledgerRun(ticket, { rgOnly }) {
  const { spawnSync } = await import("node:child_process");
  if (ticket && !(ticket in graph.blockers)) {
    console.error(`unknown or merged ticket ${ticket}`);
    return { failed: 1 };
  }
  const repoRoot = join(root, "..", "..", "..");
  const counts = { pass: 0, fail: 0, error: 0, skip: 0 };
  const indent = (text) => text.trim().split("\n").slice(0, 6).map((l) => `     ${l}`).join("\n");
  for (const row of ledgerRows()) {
    const owners = row.owner.match(ID_PATTERN) ?? [];
    if (ticket && !owners.includes(ticket)) continue;
    for (const cmd of proofCommands(row.proof)) {
      const where = `${owners.join(",")} ${row.file}:${row.line}`;
      const words = splitWords(cmd);
      if (!words) {
        counts.error += 1;
        console.log(`ERROR ${where} uses a shell operator: ${cmd}`);
        continue;
      }
      const [exe, ...args] = words;
      if (rgOnly && exe !== "rg") {
        counts.skip += 1;
        console.log(`SKIP  ${where} ${cmd}`);
        continue;
      }
      let result = spawnSync(exe, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      // Windows package managers often ship .cmd shims, which spawn cannot run without a shell.
      if (result.error?.code === "ENOENT" && process.platform === "win32" && exe !== "rg") {
        result = spawnSync(`${exe}.cmd`, args, { cwd: repoRoot, encoding: "utf8", shell: true, maxBuffer: 16 * 1024 * 1024 });
      }
      if (result.error) {
        counts.error += 1;
        console.log(`ERROR ${where} ${cmd}\n     ${result.error.message}`);
        continue;
      }
      const isSearch = exe === "rg";
      const clean = isSearch ? result.status === 1 && !result.stdout.trim() : result.status === 0;
      const broken = isSearch && result.status !== 0 && result.status !== 1;
      if (clean) {
        counts.pass += 1;
        console.log(`PASS  ${where} ${cmd}`);
      } else if (broken) {
        counts.error += 1;
        console.log(`ERROR ${where} ${cmd} (exit ${result.status})\n${indent(result.stderr)}`);
      } else {
        counts.fail += 1;
        console.log(`FAIL  ${where} ${cmd} (exit ${result.status})\n${indent(isSearch ? result.stdout : `${result.stdout}\n${result.stderr}`)}`);
      }
    }
  }
  console.log(`\n${counts.pass} passed, ${counts.fail} failed, ${counts.error} errors, ${counts.skip} skipped`);
  if (counts.pass + counts.fail + counts.error + counts.skip === 0) console.log("no proofs found for this selection");
  return { failed: counts.fail + counts.error + (counts.pass + counts.fail + counts.error + counts.skip === 0 ? 1 : 0) };
}

const command = process.argv[2] ?? "check";
if (command === "ledger") {
  const problems = ledgerCheck();
  console.log(problems.length ? problems.join("\n") : `ok: ${ledgerRows().length} ledger rows, each with one active owner and a runnable proof`);
  process.exit(problems.length ? 1 : 0);
}
if (command === "ledger-run") {
  // node graph.mjs ledger-run [ticket] [--rg-only]
  const args = process.argv.slice(3);
  const ticket = args.find((a) => !a.startsWith("--"));
  const { failed } = await ledgerRun(ticket, { rgOnly: args.includes("--rg-only") });
  process.exit(failed ? 1 : 0);
}
const { tickets, waves, problems } = check();
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (command === "check") {
  const maxWave = Math.max(...waves.values());
  console.log(`ok: ${allIds().length} tickets, ${Object.keys(graph.dropped).length} merged, ${maxWave} waves`);
} else if (command === "sync-docs") {
  syncDocs(tickets);
  console.log("section docs updated");
} else if (command === "render") {
  render(tickets, waves);
  console.log("tickets.md written");
} else if (command === "issues") {
  issues(tickets);
  epics(tickets, waves);
  console.log("issue and epic bodies written to tools/out");
} else {
  console.error(`unknown command ${command}`);
  process.exit(1);
}
