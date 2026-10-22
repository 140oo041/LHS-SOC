/**
 * Unified diffs: producing them for the memory store, and reading them for
 * display. GitHub supplies its own patches in the same format, so the diff
 * view renders either without knowing which store made it.
 */

type Op = { kind: " " | "-" | "+"; text: string };

// Above this, a quadratic diff would stall a request; such a change is shown
// as a whole-file replacement instead.
const MAX_LINES = 4000;

function splitLines(text: string) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineOps(before: string[], after: string[]): Op[] {
  if (before.length * after.length > MAX_LINES * MAX_LINES / 4 || before.length > MAX_LINES || after.length > MAX_LINES) {
    return [...before.map((text) => ({ kind: "-" as const, text })), ...after.map((text) => ({ kind: "+" as const, text }))];
  }
  // Longest common subsequence, filled from the end so the walk below can go
  // forwards.
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = before[i] === after[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: " ", text: before[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ kind: "-", text: before[i] });
      i += 1;
    } else {
      ops.push({ kind: "+", text: after[j] });
      j += 1;
    }
  }
  while (i < before.length) ops.push({ kind: "-", text: before[i++] });
  while (j < after.length) ops.push({ kind: "+", text: after[j++] });
  return ops;
}

/** Hunks with three lines of context, in the format `git diff` prints. */
export function unifiedPatch(before: string, after: string, context = 3): string {
  const ops = lineOps(splitLines(before), splitLines(after));
  const changed = ops.map((op, index) => (op.kind === " " ? -1 : index)).filter((index) => index >= 0);
  if (!changed.length) return "";

  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length, index + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }

  const out: string[] = [];
  for (const [start, end] of hunks) {
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "+") oldLine += 1;
      if (op.kind !== "-") newLine += 1;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out.join("\n");
}

export type PatchLine = { kind: "context" | "added" | "removed" | "hunk"; text: string; oldNumber?: number; newNumber?: number };

/** Reads a unified patch into numbered lines for display. */
export function parsePatch(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const raw of patch.split("\n")) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      oldNumber = Number(header[1]);
      newNumber = Number(header[2]);
      lines.push({ kind: "hunk", text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "added", text: raw.slice(1), newNumber: newNumber++ });
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "removed", text: raw.slice(1), oldNumber: oldNumber++ });
    } else if (raw.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    } else {
      lines.push({ kind: "context", text: raw.slice(1), oldNumber: oldNumber++, newNumber: newNumber++ });
    }
  }
  return lines;
}
