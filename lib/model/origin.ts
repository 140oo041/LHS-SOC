/**
 * Where a canvas goes when a block is dragged above or left of everything
 * else.
 *
 * Stored layouts keep every position non-negative, so the canvas is shifted
 * until its top-left block sits a small margin from the origin. The server
 * applies this to the model and the canvas applies the same shift to what it
 * shows, so nothing visibly jumps between the drop and the commit. Pure and
 * dependency-free so it can run on both sides.
 */

export const ORIGIN_MARGIN = 20;

/**
 * How far past the origin a block may be dragged before it stops. Past the
 * origin the whole canvas shifts on commit, so the limit also bounds how far
 * one drag can move every other block.
 */
export const MIN_COORDINATE = -400;

/** The largest move (dx, dy) that keeps every rect at or beyond the limit. */
export function clampMove(rects: Iterable<{ x: number; y: number }>, dx: number, dy: number): { dx: number; dy: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
  }
  return { dx: Math.max(dx, MIN_COORDINATE - minX), dy: Math.max(dy, MIN_COORDINATE - minY) };
}

export function originShift(rects: Iterable<{ x: number; y: number }>): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
  }
  return { x: minX < 0 ? ORIGIN_MARGIN - minX : 0, y: minY < 0 ? ORIGIN_MARGIN - minY : 0 };
}
