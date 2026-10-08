// One-off: graph and decision follow-ups reported by the round 1 fix agents. Kept for the audit trail.
const fs = require("fs");
const path = require("path");
const graphFile = path.join(__dirname, "graph.json");
const g = JSON.parse(fs.readFileSync(graphFile, "utf8"));
if (!g.blockers["S08F-05"].includes("S05-10")) g.blockers["S08F-05"].push("S05-10");
g.notes["S12T-08"] = g.notes["S12T-08"].replace(
  "; delete S11's alternate `servers.list` sketch and the unimplemented `detectLocalPorts` declaration.",
  "; S11-09 deletes the unimplemented `detectLocalPorts` declaration.",
);
fs.writeFileSync(graphFile, JSON.stringify(g, null, 2) + "\n");

const decisionsFile = path.join(__dirname, "..", "decisions.md");
const decisions = fs.readFileSync(decisionsFile, "utf8").replace(
  "| T11 | Actions only work on the legacy terminal backend. Keep two backends? | Keep one backend; decide in S12T-01. |",
  "| T11 | Two terminal backends exist (legacy and modern), and both run actions. Keep one? | Keep legacy and delete modern in S12T-01. 12a risk R1 lists what modern would have given; reverse this before S12T-01 starts if you want modern. |",
);
fs.writeFileSync(decisionsFile, decisions);
console.log("S08F-05 blockers:", g.blockers["S08F-05"].join(", "));
console.log("T11 updated:", decisions.includes("Keep legacy and delete modern"));
