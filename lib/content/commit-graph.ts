import type { GraphCommit } from "@/lib/content/types";

/**
 * Lays commits out as a graph, the way `git log --graph` and GitHub do:
 * newest first, each line of development in its own lane, branches forking
 * off and merges joining back.
 *
 * Commits come in newest first, then are put in topological order (a commit
 * after every child of it that is shown), so a line never runs upwards.
 * Each commit takes the lane that was waiting for it; its first parent
 * continues that lane, and any further parents (a merge) take lanes of their
 * own. Lanes waiting for the same commit join at it.
 */

export type GraphEdge = {
  /** The lane the line leaves the child in, and the lane it travels down. */
  fromLane: number;
  viaLane: number;
  toLane: number;
  fromRow: number;
  /** null when the parent is older than the history shown. */
  toRow: number | null;
};

export type GraphRow = { commit: GraphCommit; lane: number };

export type CommitGraph = { rows: GraphRow[]; edges: GraphEdge[]; laneCount: number };

export function topologicalOrder(commits: GraphCommit[]): GraphCommit[] {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const waitingOn = new Map<string, number>(commits.map((commit) => [commit.sha, 0]));
  for (const commit of commits) {
    for (const parent of commit.parents) if (bySha.has(parent)) waitingOn.set(parent, waitingOn.get(parent)! + 1);
  }
  const newestFirst = [...commits].sort((a, b) => b.date.localeCompare(a.date));
  const ordered: GraphCommit[] = [];
  const done = new Set<string>();
  while (ordered.length < commits.length) {
    const next = newestFirst.find((commit) => !done.has(commit.sha) && waitingOn.get(commit.sha) === 0) ?? newestFirst.find((commit) => !done.has(commit.sha))!;
    done.add(next.sha);
    ordered.push(next);
    for (const parent of next.parents) if (waitingOn.has(parent)) waitingOn.set(parent, waitingOn.get(parent)! - 1);
  }
  return ordered;
}

export function layoutGraph(commits: GraphCommit[]): CommitGraph {
  const ordered = topologicalOrder(commits);
  const rowOf = new Map(ordered.map((commit, index) => [commit.sha, index]));
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];
  const pending: Array<{ fromLane: number; viaLane: number; fromRow: number; parent: string }> = [];
  let laneCount = 0;

  const freeLane = () => {
    const index = lanes.indexOf(null);
    if (index !== -1) return index;
    lanes.push(null);
    return lanes.length - 1;
  };

  ordered.forEach((commit, row) => {
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) lane = freeLane();
    // Other lanes that were heading for this commit end here.
    lanes.forEach((waiting, index) => {
      if (waiting === commit.sha && index !== lane) lanes[index] = null;
    });
    lanes[lane] = null;

    commit.parents.forEach((parent, index) => {
      let via: number;
      if (index === 0) {
        via = lane;
      } else {
        via = lanes.indexOf(parent);
        if (via === -1) via = freeLane();
      }
      if (rowOf.has(parent)) lanes[via] = parent;
      pending.push({ fromLane: lane, viaLane: via, fromRow: row, parent });
    });
    rows.push({ commit, lane });
    laneCount = Math.max(laneCount, lanes.length, lane + 1);
  });

  const laneOf = new Map(rows.map((row) => [row.commit.sha, row.lane]));
  const edges = pending.map((edge) => ({
    fromLane: edge.fromLane,
    viaLane: edge.viaLane,
    toLane: laneOf.get(edge.parent) ?? edge.viaLane,
    fromRow: edge.fromRow,
    toRow: rowOf.get(edge.parent) ?? null,
  }));
  return { rows, edges, laneCount: Math.max(1, laneCount) };
}
