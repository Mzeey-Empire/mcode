// One-off: graph and decision edits agreed after Astra review round 2. Kept for the audit trail.
const fs = require("fs");
const path = require("path");
const graphFile = path.join(__dirname, "graph.json");
const g = JSON.parse(fs.readFileSync(graphFile, "utf8"));

// N4: new-thread Implement runs through the startup rule S04-07 defines.
if (!g.blockers["S07-08"].includes("S04-07")) g.blockers["S07-08"].push("S04-07");

// N7 and N11: Setup readiness is exit 0; a port is display only; the Keeps running toggle waits for T3.
g.notes["S12T-11"] = g.notes["S12T-11"].replace(
  "Readiness: an action is ready on exit 0 or on a port detected from the current run, whichever comes first (decision T3).",
  "Readiness: a startup action is ready only when it exits 0. A detected port is a display fact for the Browser and the terminal, never Setup readiness. The per-action \"Keeps running\" toggle (start without awaiting) is excluded from this ticket until the user answers decision T3; if approved it becomes its own ticket.",
);
g.needsDecision["S12T-11"] = "Decision T3 decides whether a follow-up adds the Keeps running toggle. S12T-11 itself is buildable now: startup actions are awaited to exit 0.";
g.notes["S12T-08"] = g.notes["S12T-08"].replace(
  "TCP reachability is not app health; say so in copy.",
  "TCP reachability is not app health and never releases Setup; say so in copy. The synthesized command echo is excluded from detector input.",
);
fs.writeFileSync(graphFile, JSON.stringify(g, null, 2) + "\n");

const decisionsFile = path.join(__dirname, "..", "decisions.md");
let decisions = fs.readFileSync(decisionsFile, "utf8");
const t3Start = decisions.indexOf("| T3 |");
const t3End = decisions.indexOf("\n", t3Start);
decisions =
  decisions.slice(0, t3Start) +
  "| T3 | Startup actions are awaited until they exit 0 (S12T-11 builds this). A dev server never exits, so it cannot be a startup action under that rule. Add a per-action \"Keeps running\" toggle that starts the action and does not wait for it? | Yes, as a follow-up ticket after S12T-11, defined when you answer. A listening port never counts as ready, because another process can answer on it. |" +
  decisions.slice(t3End);
decisions = decisions.replace(
  "| P7 | A way to clear session approvals? | Not now. |",
  "| P7 | A way to clear session approvals? | Not now. |\n| P8 | After a crash, Mcode may not know whether a deny note already reached the provider. Send it again automatically, or ask? | Ask. The note shows as \"Delivery unknown\" with Send again and Remove; Mcode never re-sends it on its own. |",
);
fs.writeFileSync(decisionsFile, decisions);
console.log("S07-08:", g.blockers["S07-08"].join(", "));
console.log("T3 rewritten:", decisions.includes("Keeps running\" toggle that starts"));
console.log("P8 added:", decisions.includes("| P8 |"));
