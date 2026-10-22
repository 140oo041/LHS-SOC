import Link from "next/link";
import type { CommitGraph } from "@/lib/content/commit-graph";
import { RollbackButton } from "./rollback-button";

const ROW = 56;
const LANE = 18;
const PAD = 14;
const COLORS = ["#0f766e", "#6d28d9", "#d97706", "#2563eb", "#db2777", "#16a34a", "#dc2626", "#0891b2"];

const laneX = (lane: number) => PAD + lane * LANE;
const rowY = (row: number) => row * ROW + ROW / 2;
const color = (lane: number) => COLORS[lane % COLORS.length];

function edgePath(edge: CommitGraph["edges"][number]) {
  const x1 = laneX(edge.fromLane);
  const y1 = rowY(edge.fromRow);
  const xv = laneX(edge.viaLane);
  let d = `M ${x1} ${y1}`;
  // Leave the child towards the lane this line travels in.
  d += edge.viaLane === edge.fromLane ? ` L ${xv} ${y1 + ROW / 2}` : ` C ${x1} ${y1 + ROW * 0.35}, ${xv} ${y1 + ROW * 0.15}, ${xv} ${y1 + ROW / 2}`;
  if (edge.toRow === null) return `${d} L ${xv} ${y1 + ROW * 0.95}`;
  const xt = laneX(edge.toLane);
  const y2 = rowY(edge.toRow);
  d += ` L ${xv} ${y2 - ROW / 2}`;
  d += edge.toLane === edge.viaLane ? ` L ${xt} ${y2}` : ` C ${xv} ${y2 - ROW * 0.15}, ${xt} ${y2 - ROW * 0.35}, ${xt} ${y2}`;
  return d;
}

function when(date: string) {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? "" : value.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Every commit on the branches shown, as a graph: lines fork where a branch
 * started and join where a change request merged. Each row opens the
 * commit, browses the wiki or canvas as it was, or rolls back to it.
 */
export function CommitGraphView({
  graph,
  labels,
  branch,
  defaultBranch,
  canBrowse,
  canRollBack,
}: {
  graph: CommitGraph;
  labels: Record<string, string[]>;
  branch: string;
  defaultBranch: string;
  canBrowse: boolean;
  canRollBack: boolean;
}) {
  const width = PAD * 2 + (graph.laneCount - 1) * LANE;
  const height = graph.rows.length * ROW;
  return (
    <div className="commit-graph" style={{ ["--graph-width" as string]: `${width}px`, ["--graph-row" as string]: `${ROW}px` }}>
      <svg className="commit-graph-lines" width={width} height={height} aria-hidden="true">
        {graph.edges.map((edge, index) => (
          <path key={index} d={edgePath(edge)} className={edge.toRow === null ? "stub" : undefined} style={{ stroke: color(edge.viaLane) }} />
        ))}
        {graph.rows.map((row, index) => (
          <circle
            key={row.commit.sha}
            cx={laneX(row.lane)}
            cy={rowY(index)}
            r={labels[row.commit.sha] ? 6.5 : 5}
            className={labels[row.commit.sha] ? "head" : undefined}
            style={{ fill: labels[row.commit.sha] ? "var(--paper-bright)" : color(row.lane), stroke: color(row.lane) }}
          />
        ))}
      </svg>
      <ol className="commit-graph-rows">
        {graph.rows.map(({ commit }) => {
          const [subject] = commit.message.split("\n");
          return (
            <li key={commit.sha}>
              <div className="commit-graph-main">
                <Link href={`/wiki/commits/${commit.sha}`} className="commit-graph-subject">{subject}</Link>
                {(labels[commit.sha] ?? []).map((name) => (
                  <span key={name} className={`commit-branch${name === defaultBranch ? " published" : ""}`}>{name}</span>
                ))}
              </div>
              <div className="commit-graph-meta">
                <span>{commit.atlasUser ?? commit.authorName}</span>
                <time dateTime={commit.date}>{when(commit.date)}</time>
                <Link href={`/wiki/commits/${commit.sha}`}><code>{commit.sha.slice(0, 7)}</code></Link>
                {canBrowse && <Link href={`/wiki?ref=${commit.sha}`}>Wiki</Link>}
                {canBrowse && <Link href={`/architecture?ref=${commit.sha}`}>Canvas</Link>}
                {canRollBack && <RollbackButton sha={commit.sha} branch={branch} defaultBranch={defaultBranch} />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
