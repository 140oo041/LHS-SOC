import { describe, expect, it } from "vitest";
import { boundsOf, intersects, snapMove, snapResize } from "@/components/architecture/snapping";
import { clampMove, MIN_COORDINATE, originShift } from "@/lib/model/origin";

const other = { x: 100, y: 100, w: 200, h: 100 };
const options = { threshold: 6, grid: 10 };

describe("snapMove", () => {
  it.each([
    ["left edge to left edge", { x: 103, y: 400, w: 80, h: 50 }, 100],
    ["left edge to right edge", { x: 296, y: 400, w: 80, h: 50 }, 300],
    ["right edge to left edge", { x: 24, y: 400, w: 80, h: 50 }, 20],
    ["centre to centre", { x: 162, y: 400, w: 80, h: 50 }, 160],
  ])("snaps %s", (_name, rect, x) => {
    const result = snapMove(rect, [other], options);
    expect(result.x).toBe(x);
    expect(result.guides.some((guide) => guide.axis === "x")).toBe(true);
  });

  it("falls back to the grid outside the threshold, with no guide", () => {
    const result = snapMove({ x: 47, y: 433, w: 80, h: 50 }, [other], options);
    expect(result).toEqual({ x: 50, y: 430, guides: [] });
  });

  it("draws a guide spanning both blocks", () => {
    const [guide] = snapMove({ x: 102, y: 400, w: 80, h: 50 }, [other], options).guides;
    expect(guide).toEqual({ axis: "x", at: 100, from: 100, to: 450 });
  });

  it("turns snapping off with a zero threshold and a unit grid", () => {
    expect(snapMove({ x: 103, y: 401, w: 80, h: 50 }, [other], { threshold: 0, grid: 1 })).toEqual({ x: 103, y: 401, guides: [] });
  });
});

describe("snapResize", () => {
  it("snaps only the edges being dragged", () => {
    const { rect, guides } = snapResize({ x: 0, y: 0, w: 297, h: 77 }, { right: true, bottom: true }, [other], options);
    expect(rect).toEqual({ x: 0, y: 0, w: 300, h: 80 });
    expect(guides).toHaveLength(1);
  });

  it("keeps the opposite edge fixed when the left edge moves", () => {
    const { rect } = snapResize({ x: 98, y: 300, w: 152, h: 50 }, { left: true }, [other], options);
    expect(rect.x + rect.w).toBe(250);
    expect(rect.x).toBe(100);
  });
});

describe("geometry helpers", () => {
  it("bounds a selection", () => {
    expect(boundsOf([other, { x: 0, y: 300, w: 50, h: 50 }])).toEqual({ x: 0, y: 100, w: 300, h: 250 });
    expect(boundsOf([])).toBeNull();
  });

  it("detects marquee overlap", () => {
    expect(intersects(other, { x: 290, y: 190, w: 40, h: 40 })).toBe(true);
    expect(intersects(other, { x: 301, y: 100, w: 40, h: 40 })).toBe(false);
  });

  it("stops a move at the limit past the origin", () => {
    const rects = [{ x: 100, y: 50 }, { x: 300, y: 400 }];
    expect(clampMove(rects, -1000, -20)).toEqual({ dx: MIN_COORDINATE - 100, dy: -20 });
    expect(clampMove(rects, 40, -2000)).toEqual({ dx: 40, dy: MIN_COORDINATE - 50 });
  });

  it("shifts a canvas only when something is past the origin", () => {
    expect(originShift([{ x: 40, y: 10 }])).toEqual({ x: 0, y: 0 });
    expect(originShift([{ x: -30, y: 10 }, { x: 200, y: -5 }])).toEqual({ x: 50, y: 25 });
  });
});
