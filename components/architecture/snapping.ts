/**
 * Smart guides for moving and resizing blocks on the canvas.
 *
 * A moving edge or centre within the threshold of another block's edge or
 * centre locks to it and a guide line is drawn; otherwise the position falls
 * back to the layout grid. The threshold is given in canvas units by the
 * caller, which converts it from screen pixels so snapping feels the same at
 * every zoom. Pure, so it is tested without a canvas.
 */

export type SnapRect = { x: number; y: number; w: number; h: number };
export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
export type SnapOptions = { threshold: number; grid: number };

type Axis = "x" | "y";

const start = (rect: SnapRect, axis: Axis) => (axis === "x" ? rect.x : rect.y);
const size = (rect: SnapRect, axis: Axis) => (axis === "x" ? rect.w : rect.h);
const lines = (rect: SnapRect, axis: Axis) => [start(rect, axis), start(rect, axis) + size(rect, axis) / 2, start(rect, axis) + size(rect, axis)];

/** The target line nearest any of the moving lines, if one is close enough. */
function nearest(moving: number[], targets: number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const value of moving) {
    for (const target of targets) {
      const delta = target - value;
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, at: target };
    }
  }
  return best;
}

/** A guide along `at`, spanning the moving block and every block that shares the line. */
function guideFor(axis: Axis, at: number, rect: SnapRect, others: SnapRect[]): Guide {
  const cross: Axis = axis === "x" ? "y" : "x";
  let from = start(rect, cross);
  let to = from + size(rect, cross);
  for (const other of others) {
    if (!lines(other, axis).some((line) => Math.abs(line - at) < 0.5)) continue;
    from = Math.min(from, start(other, cross));
    to = Math.max(to, start(other, cross) + size(other, cross));
  }
  return { axis, at, from, to };
}

const toGrid = (value: number, grid: number) => (grid > 1 ? Math.round(value / grid) * grid : value);

/** Where a block (or a selection's bounding box) dragged to `rect` should land. */
export function snapMove(rect: SnapRect, others: SnapRect[], { threshold, grid }: SnapOptions): { x: number; y: number; guides: Guide[] } {
  const result = { x: rect.x, y: rect.y, guides: [] as Guide[] };
  for (const axis of ["x", "y"] as const) {
    const hit = threshold > 0 ? nearest(lines(rect, axis), others.flatMap((other) => lines(other, axis)), threshold) : null;
    const value = hit ? start(rect, axis) + hit.delta : toGrid(start(rect, axis), grid);
    result[axis] = value;
    if (hit) {
      const placed = { ...rect, [axis]: value };
      result.guides.push(guideFor(axis, hit.at, placed, others));
    }
  }
  return result;
}

export type Edges = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };

/**
 * Where the moving edges of a block being resized should land. Only the edges
 * being dragged snap; the opposite edges stay put.
 */
export function snapResize(rect: SnapRect, edges: Edges, others: SnapRect[], { threshold, grid }: SnapOptions): { rect: SnapRect; guides: Guide[] } {
  let left = rect.x;
  let right = rect.x + rect.w;
  let top = rect.y;
  let bottom = rect.y + rect.h;
  const guides: Guide[] = [];
  const xTargets = others.flatMap((other) => lines(other, "x"));
  const yTargets = others.flatMap((other) => lines(other, "y"));

  const snapEdge = (value: number, targets: number[]) => {
    const hit = threshold > 0 ? nearest([value], targets, threshold) : null;
    return hit ? { value: hit.at, snapped: true } : { value: toGrid(value, grid), snapped: false };
  };

  const snappedX: number[] = [];
  const snappedY: number[] = [];
  if (edges.left) {
    const edge = snapEdge(left, xTargets);
    left = edge.value;
    if (edge.snapped) snappedX.push(left);
  }
  if (edges.right) {
    const edge = snapEdge(right, xTargets);
    right = edge.value;
    if (edge.snapped) snappedX.push(right);
  }
  if (edges.top) {
    const edge = snapEdge(top, yTargets);
    top = edge.value;
    if (edge.snapped) snappedY.push(top);
  }
  if (edges.bottom) {
    const edge = snapEdge(bottom, yTargets);
    bottom = edge.value;
    if (edge.snapped) snappedY.push(bottom);
  }

  const next = { x: left, y: top, w: right - left, h: bottom - top };
  for (const at of snappedX) guides.push(guideFor("x", at, next, others));
  for (const at of snappedY) guides.push(guideFor("y", at, next, others));
  return { rect: next, guides };
}

/** The smallest rectangle around all of them. */
export function boundsOf(rects: SnapRect[]): SnapRect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Whether two rectangles overlap at all, for marquee selection. */
export function intersects(a: SnapRect, b: SnapRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
