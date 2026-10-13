import type { ApprovalSubject } from "@mcode/contracts";

type FilePatch = Extract<ApprovalSubject, { kind: "file_edit" }>["files"][number];

/** Count unified hunk lines before omitting patches that exceed the approval wire bound. */
export function approvalPatch(patch: string | undefined): Pick<FilePatch, "patch" | "patchTruncated" | "additions" | "deletions"> {
  const counts = countPatchLines(patch ?? "");
  return { ...counts, ...(patch === undefined || patch.length > 262_144
    ? { patchTruncated: true } : { patch }) };
}

function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let remaining = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) remaining = Number(hunk[1] ?? 1) + Number(hunk[2] ?? 1);
    else if (remaining > 0) {
      switch (line[0]) {
        case "+": additions++; remaining--; break;
        case "-": deletions++; remaining--; break;
        case " ": remaining -= 2; break;
      }
    }
  }
  return { additions, deletions };
}
