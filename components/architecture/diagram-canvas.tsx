"use client";

import { useCallback, useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { clampMove, MIN_COORDINATE, originShift } from "@/lib/model/origin";
import { portPoint, routePath, type Box } from "@/lib/model/routing";
import type { Side } from "@/lib/model/schema";
import type { ModelEdit } from "@/lib/model/edit";
import type { ViewLayout, ViewPort, ViewSnapshot } from "@/lib/model/view";
import { CanvasPopoverView, describe, type CanvasPopover } from "./canvas-popovers";
import { CanvasNode, handlePoint, SelectionOverlay, type Emphasis, type Handle, type NodeHandlers, type NodeRect, type Point } from "./canvas-node";
import { CanvasToolbar, type Tool } from "./canvas-toolbar";
import type { Lens } from "./lens";
import { ConnectionEditor } from "./model-editor";
import type { ModelSession } from "./model-session";
import { boundsOf, intersects, snapMove, snapResize, type Guide } from "./snapping";
import { useCamera, type Insets } from "./use-camera";

type Props = {
  snapshot: ViewSnapshot;
  focusId: string;
  selectedId: string | null;
  lens: Lens;
  onSelect(blockId: string): void;
  onDeselect(): void;
  onEnter(blockId: string): void;
  onLeave(): void;
  canLeave: boolean;
  /** Mark what the branch changed, when the snapshot carries changes. */
  showChanges?: boolean;
  /** Present when the viewer can edit the model on this branch. */
  session?: ModelSession | null;
  /** Screen space covered by the floating panels, so fit and reveal avoid it. */
  insets?(): Insets;
};

/** A drag in progress on the canvas, in canvas units. */
type Drag =
  | { kind: "move"; ids: string[]; start: Point; origins: Record<string, NodeRect>; dx: number; dy: number; moved: boolean; guides: Guide[]; collapseTo: string | null }
  | { kind: "resize"; id: string; handle: Handle; start: Point; origin: NodeRect; rect: NodeRect; moved: boolean; guides: Guide[] }
  | { kind: "connect"; from: string; side: Side; point: Point; target: string | null }
  | { kind: "port"; block: string; port: string; side: Side; offset: number; moved: boolean }
  | { kind: "marquee"; start: Point; end: Point; additive: boolean; base: string[] };

/** Positions changed on the canvas, shown until the snapshot that holds them arrives. */
type Overrides = { nodes: Record<string, NodeRect>; ports: Record<string, { side: Side; offset: number }> };

const NO_OVERRIDES: Overrides = { nodes: {}, ports: {} };
const GRID = 10;
const MIN_W = 80;
const MIN_H = 50;
/** Snapping reach and drag threshold, in screen pixels. */
const SNAP_PX = 6;
const DRAG_PX = 3;
const NUDGE_COMMIT_MS = 400;

const FALLBACK_CANVAS = { width: 960, height: 620 };

/** The side of a block nearest a point, and how far along that side it is. */
function nearestEdge(rect: NodeRect, point: Point): { side: Side; offset: number } {
  const distances: Array<[Side, number]> = [
    ["left", Math.abs(point.x - rect.x)],
    ["right", Math.abs(rect.x + rect.w - point.x)],
    ["top", Math.abs(point.y - rect.y)],
    ["bottom", Math.abs(rect.y + rect.h - point.y)],
  ];
  const side = distances.sort((a, b) => a[1] - b[1])[0][0];
  const along = side === "left" || side === "right" ? (point.y - rect.y) / rect.h : (point.x - rect.x) / rect.w;
  return { side, offset: Math.round(Math.min(0.95, Math.max(0.05, along)) * 100) / 100 };
}

function typing(target: EventTarget | null) {
  return target instanceof HTMLElement && target.matches("input, textarea, select, [contenteditable='true']");
}

/** Where a resize handle drag puts a block, before snapping and minimums. */
function resized(origin: NodeRect, handle: Handle, dx: number, dy: number, keepAspect: boolean) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.w;
  let bottom = origin.y + origin.h;
  if (handle.includes("w")) left += dx;
  if (handle.includes("e")) right += dx;
  if (handle.includes("n")) top += dy;
  if (handle.includes("s")) bottom += dy;
  if (keepAspect && handle.length === 2) {
    const ratio = origin.w / origin.h;
    let w = right - left;
    let h = bottom - top;
    if (Math.abs(w / origin.w) > Math.abs(h / origin.h)) h = w / ratio;
    else w = h * ratio;
    if (handle.includes("w")) left = right - w;
    else right = left + w;
    if (handle.includes("n")) top = bottom - h;
    else bottom = top + h;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Stops a resized block's left and top edges at the limit past the origin, keeping the far edges where they are. */
function limitEdges(rect: NodeRect): NodeRect {
  const left = Math.max(rect.x, MIN_COORDINATE);
  const top = Math.max(rect.y, MIN_COORDINATE);
  return { x: left, y: top, w: rect.x + rect.w - left, h: rect.y + rect.h - top };
}

/** Holds the edge opposite the handle and grows the block back to its minimum size. */
function withMinimum(rect: NodeRect, handle: Handle): NodeRect {
  const next = { ...rect };
  if (next.w < MIN_W) {
    if (handle.includes("w")) next.x = rect.x + rect.w - MIN_W;
    next.w = MIN_W;
  }
  if (next.h < MIN_H) {
    if (handle.includes("n")) next.y = rect.y + rect.h - MIN_H;
    next.h = MIN_H;
  }
  return next;
}

export function DiagramCanvas({
  snapshot,
  focusId,
  selectedId,
  lens,
  onSelect,
  onDeselect,
  onEnter,
  onLeave,
  canLeave,
  showChanges = false,
  session = null,
  insets,
}: Props) {
  const editing = Boolean(session);
  const [tool, setTool] = useState<Tool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [popover, setPopover] = useState<(CanvasPopover & { screen: { left: number; top: number } }) | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const gridId = `canvas-grid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  // The canvas can hold several blocks at once; the explorer's selection is
  // the primary one, which the inspector and the address bar follow.
  const [selection, setSelection] = useState<string[]>(selectedId ? [selectedId] : []);
  const [seenSelected, setSeenSelected] = useState(selectedId);
  if (seenSelected !== selectedId) {
    setSeenSelected(selectedId);
    if (!selectedId) setSelection([]);
    else if (!selection.includes(selectedId)) setSelection([selectedId]);
  }

  // What was moved here stays where it was put until the snapshot that
  // contains the move arrives, so nothing jumps back while a commit is out.
  const [overrides, setOverrides] = useState<Overrides>(NO_OVERRIDES);
  const [seenSnapshot, setSeenSnapshot] = useState(snapshot);
  if (seenSnapshot !== snapshot && !session?.pending) {
    setSeenSnapshot(snapshot);
    setOverrides(NO_OVERRIDES);
  }

  const authored = snapshot.layouts[focusId];

  /** The layout as committed or committing, without the drag in progress. */
  const base = useMemo((): ViewLayout | undefined => {
    if (!authored) return authored;
    const nodes = { ...authored.nodes };
    for (const [key, rect] of Object.entries(overrides.nodes)) {
      const [canvasId, id] = key.split("::");
      if (canvasId === focusId && nodes[id]) nodes[id] = rect;
    }
    return { canvas: authored.canvas, nodes };
  }, [authored, overrides.nodes, focusId]);

  /** What is drawn: the base layout with the drag applied. */
  const layout = useMemo((): ViewLayout | undefined => {
    if (!base || !drag) return base;
    if (drag.kind === "move" && drag.moved) {
      const nodes = { ...base.nodes };
      for (const id of drag.ids) nodes[id] = { ...drag.origins[id], x: drag.origins[id].x + drag.dx, y: drag.origins[id].y + drag.dy };
      return { ...base, nodes };
    }
    if (drag.kind === "resize" && drag.moved) return { ...base, nodes: { ...base.nodes, [drag.id]: drag.rect } };
    return base;
  }, [base, drag]);

  const basePorts = useMemo((): Record<string, ViewPort[]> => {
    if (!Object.keys(overrides.ports).length) return snapshot.ports;
    return Object.fromEntries(
      Object.entries(snapshot.ports).map(([blockId, list]) => [blockId, list.map((port) => ({ ...port, ...overrides.ports[`${blockId}/${port.id}`] }))]),
    );
  }, [snapshot.ports, overrides.ports]);

  const ports = useMemo((): Record<string, ViewPort[]> => {
    if (drag?.kind !== "port" || !drag.moved) return basePorts;
    return {
      ...basePorts,
      [drag.block]: basePorts[drag.block].map((port) => (port.id === drag.port ? { ...port, side: drag.side, offset: drag.offset } : port)),
    };
  }, [basePorts, drag]);

  const removed = useCallback((id: string) => snapshot.changes?.blocks[id] === "removed", [snapshot.changes]);

  // Read by handlers and timers that outlive the render they were made in.
  const baseRef = useRef(base);
  const layoutRef = useRef(layout);
  useLayoutEffect(() => {
    baseRef.current = base;
    layoutRef.current = layout;
  });

  const {
    frameRef,
    layerRef,
    gridRef,
    view: viewRef,
    zoom,
    panning: dragPanning,
    fit,
    zoomBy,
    zoomTo,
    zoomToRect,
    panBy,
    revealRect,
    toCanvas,
    startPan,
  } = useCamera({
    focusKey: focusId,
    insets,
    bounds: () => {
      const nodes = Object.values(baseRef.current?.nodes ?? {});
      return boundsOf(nodes) ?? { x: 0, y: 0, w: FALLBACK_CANVAS.width, h: FALLBACK_CANVAS.height };
    },
  });

  // A removed block stays on the canvas as a ghost so the branch's changes
  // read in place. Ghosts sit beneath live blocks, and one is dropped once a
  // live block is put over the space it left.
  const nodes = useMemo(() => {
    if (!layout) return [];
    const entries = Object.entries(layout.nodes)
      .map(([id, rect]) => ({ id, rect, block: snapshot.blocks[id] }))
      .filter((entry) => Boolean(entry.block))
      .sort((a, b) => Number(removed(b.id)) - Number(removed(a.id)) || a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    const live = entries.filter((entry) => !removed(entry.id));
    return entries.filter((entry) => !removed(entry.id) || !live.some((other) => intersects(entry.rect, other.rect)));
  }, [layout, snapshot.blocks, removed]);

  /** The routing area: the authored canvas, grown to whatever is drawn. */
  const area = useCallback((source: ViewLayout) => {
    const rects = Object.values(source.nodes);
    return {
      width: Math.max(source.canvas.width, ...rects.map((rect) => rect.x + rect.w + 40)),
      height: Math.max(source.canvas.height, ...rects.map((rect) => rect.y + rect.h + 40)),
    };
  }, []);

  // Routing runs Dijkstra per edge, so it is memoised on the settled layout
  // only. During a drag just the edges of what moves are redrawn, with
  // obstacles ignored; the full route returns on drop.
  const routed = useMemo(() => {
    if (!base) return new Map<string, string>();
    const boxes: Box[] = Object.values(base.nodes);
    const size = area(base);
    const paths = new Map<string, string>();
    for (const connection of snapshot.connections) {
      const fromBox = base.nodes[connection.from];
      const toBox = base.nodes[connection.to];
      const fromPort = basePorts[connection.from]?.find((port) => port.id === connection.fromPort);
      const toPort = basePorts[connection.to]?.find((port) => port.id === connection.toPort);
      if (!fromBox || !toBox || !fromPort || !toPort) continue;
      paths.set(
        connection.id,
        routePath(portPoint(fromBox, fromPort.side, fromPort.offset), portPoint(toBox, toPort.side, toPort.offset), fromPort.side, toPort.side, {
          obstacles: boxes.filter((box) => box !== fromBox && box !== toBox),
          ...size,
        }),
      );
    }
    return paths;
  }, [base, basePorts, snapshot.connections, area]);

  const edges = useMemo(() => {
    if (!layout) return [];
    const moving = new Set<string>(
      drag?.kind === "move" && drag.moved ? drag.ids : drag?.kind === "resize" && drag.moved ? [drag.id] : drag?.kind === "port" && drag.moved ? [drag.block] : [],
    );
    const size = moving.size ? area(layout) : null;
    return snapshot.connections
      .filter((connection) => routed.has(connection.id))
      .map((connection) => {
        let d = routed.get(connection.id)!;
        if (size && (moving.has(connection.from) || moving.has(connection.to))) {
          const fromPort = ports[connection.from].find((port) => port.id === connection.fromPort)!;
          const toPort = ports[connection.to].find((port) => port.id === connection.toPort)!;
          d = routePath(
            portPoint(layout.nodes[connection.from], fromPort.side, fromPort.offset),
            portPoint(layout.nodes[connection.to], toPort.side, toPort.offset),
            fromPort.side,
            toPort.side,
            { obstacles: [], ...size },
          );
        }
        return { connection, d, color: snapshot.protocols[connection.protocol]?.color ?? "var(--muted)" };
      });
  }, [layout, drag, routed, ports, snapshot.connections, snapshot.protocols, area]);

  const changes = showChanges ? snapshot.changes : undefined;
  const changedWithin = useMemo(() => new Set(changes?.within ?? []), [changes]);
  const diffClass = useCallback(
    (blockId: string) => {
      if (!changes) return "";
      const status = changes.blocks[blockId];
      if (status) return ` diff-${status}`;
      return changedWithin.has(blockId) ? " diff-within" : "";
    },
    [changes, changedWithin],
  );

  const stepBlocks = useMemo(() => {
    if (lens.kind !== "sequence") return null;
    const sequence = snapshot.sequences.find((item) => item.id === lens.sequenceId);
    if (!sequence) return null;
    const index = Math.min(lens.step, sequence.steps.length - 1);
    return new Set(sequence.steps[index]?.blocks ?? []);
  }, [lens, snapshot.sequences]);

  const nodeEmphasis = (blockId: string): Emphasis => {
    if (lens.kind === "protocol") {
      return (snapshot.ports[blockId] ?? []).some((port) => port.protocol === lens.protocol) ? "active" : "dim";
    }
    if (stepBlocks) return stepBlocks.has(blockId) ? "active" : "dim";
    return "normal";
  };

  const edgeEmphasis = (protocol: string, from: string, to: string): Emphasis => {
    if (lens.kind === "protocol") return protocol === lens.protocol ? "active" : "dim";
    if (stepBlocks) return stepBlocks.has(from) && stepBlocks.has(to) ? "active" : "dim";
    return "normal";
  };

  // -------------------------------------------------------------------------
  // Selection

  const onCanvas = useCallback((id: string) => Boolean(layout?.nodes[id]), [layout]);
  const editable = useCallback((id: string) => onCanvas(id) && !removed(id) && Boolean(snapshot.blocks[id]), [onCanvas, removed, snapshot.blocks]);

  const selectOnly = (ids: string[], primary?: string | null) => {
    setSelection(ids);
    setSelectedConnection(null);
    const next = primary ?? ids.at(-1) ?? null;
    if (next) {
      if (next !== selectedId) onSelect(next);
    } else if (selectedId) onDeselect();
  };

  // -------------------------------------------------------------------------
  // Editing on the canvas

  /** Pixel position in the frame for a canvas point, kept inside the frame. */
  const screenAt = (point: Point) => {
    const frame = frameRef.current!;
    const view = viewRef.current;
    return {
      left: Math.min(Math.max(8, point.x * view.k + view.x), Math.max(8, frame.clientWidth - 290)),
      top: Math.min(Math.max(8, point.y * view.k + view.y), Math.max(8, frame.clientHeight - 300)),
    };
  };

  const openPopover = (next: CanvasPopover) => setPopover({ ...next, screen: screenAt(next) });

  /** The block under a point, the smallest if several overlap. */
  const blockAt = (point: Point, except: string) => {
    let best: { id: string; area: number } | null = null;
    for (const [id, rect] of Object.entries(layout?.nodes ?? {})) {
      if (id === except || removed(id) || !snapshot.blocks[id]) continue;
      if (point.x < rect.x || point.x > rect.x + rect.w || point.y < rect.y || point.y > rect.y + rect.h) continue;
      const size = rect.w * rect.h;
      if (!best || size < best.area) best = { id, area: size };
    }
    return best?.id ?? null;
  };

  /**
   * Commits blocks moved or resized on this canvas. Anything dragged past
   * the origin shifts the whole canvas back, as the server will; the camera
   * moves by the same amount so nothing visibly jumps.
   */
  const commitRects = (rects: Record<string, NodeRect>) => {
    if (!session || !baseRef.current) return;
    const all: Record<string, NodeRect> = {};
    for (const [id, rect] of Object.entries(baseRef.current.nodes)) if (!removed(id)) all[id] = rect;
    Object.assign(all, rects);
    const shift = originShift(Object.values(all));
    const shifted = Boolean(shift.x || shift.y);
    const placed: Record<string, NodeRect> = {};
    for (const [id, rect] of Object.entries(shifted ? all : rects)) placed[`${focusId}::${id}`] = { ...rect, x: rect.x + shift.x, y: rect.y + shift.y };
    setOverrides((current) => ({ ...current, nodes: { ...current.nodes, ...placed } }));
    const k = viewRef.current.k;
    if (shifted) panBy(-shift.x * k, -shift.y * k);

    const ids = Object.keys(rects);
    const [only] = ids;
    const edit: ModelEdit =
      ids.length === 1 && !shifted
        ? { op: "moveNode", canvas: focusId, id: only, x: rects[only].x, y: rects[only].y, width: rects[only].w, height: rects[only].h }
        : { op: "moveNodes", canvas: focusId, nodes: ids.map((id) => ({ id, x: rects[id].x, y: rects[id].y, width: rects[id].w, height: rects[id].h })) };
    void session.submit(edit).then((result) => {
      if (result.ok) return;
      setOverrides((current) => {
        const next = { ...current.nodes };
        for (const key of Object.keys(placed)) delete next[key];
        return { ...current, nodes: next };
      });
      if (shifted) panBy(shift.x * viewRef.current.k, shift.y * viewRef.current.k);
    });
  };

  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nudged = useRef(new Set<string>());
  useEffect(() => () => clearTimeout(nudgeTimer.current), []);

  /** Arrow keys move the selection at once and commit when the keys go quiet. */
  const nudge = (dx: number, dy: number) => {
    const ids = selection.filter(editable);
    if (!ids.length || !base) return;
    ({ dx, dy } = clampMove(ids.map((id) => base.nodes[id]), dx, dy));
    if (!dx && !dy) return;
    setOverrides((current) => {
      const next = { ...current.nodes };
      for (const id of ids) {
        const rect = base.nodes[id];
        next[`${focusId}::${id}`] = { ...rect, x: rect.x + dx, y: rect.y + dy };
      }
      return { ...current, nodes: next };
    });
    for (const id of ids) nudged.current.add(id);
    clearTimeout(nudgeTimer.current);
    nudgeTimer.current = setTimeout(() => {
      const rects: Record<string, NodeRect> = {};
      for (const id of nudged.current) {
        const rect = baseRef.current?.nodes[id];
        if (rect) rects[id] = rect;
      }
      nudged.current.clear();
      if (Object.keys(rects).length) commitRects(rects);
    }, NUDGE_COMMIT_MS);
  };

  /** Deletes at once; the status line offers Undo. */
  const deleteSelection = () => {
    if (!session) return;
    if (selectedConnection) {
      void session.submit({ op: "removeConnection", id: selectedConnection });
      setSelectedConnection(null);
      return;
    }
    const ids = selection.filter(editable);
    if (!ids.length) return;
    for (const id of ids) void session.submit({ op: "removeBlock", id }, snapshot.blocks[id]?.parent ?? null);
    setSelection([]);
  };

  const pendingMove = useRef<PointerEvent | null>(null);
  const moveFrame = useRef(0);

  const onDragMove = useEffectEvent((event: PointerEvent) => {
    if (!drag) return;
    const point = toCanvas(event.clientX, event.clientY);
    const k = viewRef.current.k;
    const snapOff = event.metaKey || event.ctrlKey;
    const snapping = { threshold: snapOff ? 0 : SNAP_PX / k, grid: snapOff ? 1 : GRID };
    if (drag.kind === "move" || drag.kind === "resize") {
      const rawX = point.x - drag.start.x;
      const rawY = point.y - drag.start.y;
      const moved = drag.moved || Math.hypot(rawX * k, rawY * k) > DRAG_PX;
      if (!moved) return;
      const fixed = drag.kind === "move" ? new Set(drag.ids) : new Set([drag.id]);
      const others = Object.entries(base?.nodes ?? {})
        .filter(([id]) => !fixed.has(id) && !removed(id))
        .map(([, rect]) => rect);
      if (drag.kind === "move") {
        const box = boundsOf(drag.ids.map((id) => drag.origins[id]))!;
        const snapped = snapMove({ ...box, x: box.x + rawX, y: box.y + rawY }, others, snapping);
        // Blocks stop at the limit past the origin; a guide on an axis that stopped no longer lines up.
        const { dx, dy } = clampMove([box], snapped.x - box.x, snapped.y - box.y);
        const guides = snapped.guides.filter((guide) => (guide.axis === "x" ? dx === snapped.x - box.x : dy === snapped.y - box.y));
        setDrag({ ...drag, moved, dx, dy, guides });
      } else {
        const raw = resized(drag.origin, drag.handle, rawX, rawY, event.shiftKey);
        const edges = { left: drag.handle.includes("w"), right: drag.handle.includes("e"), top: drag.handle.includes("n"), bottom: drag.handle.includes("s") };
        const snapped = snapResize(withMinimum(raw, drag.handle), edges, others, snapping);
        const rect = withMinimum(limitEdges(snapped.rect), drag.handle);
        setDrag({ ...drag, moved, rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) }, guides: snapped.guides });
      }
    } else if (drag.kind === "connect") {
      setDrag({ ...drag, point, target: blockAt(point, drag.from) });
    } else if (drag.kind === "port") {
      const rect = layout?.nodes[drag.block];
      if (!rect) return;
      const edge = nearestEdge(rect, point);
      if (edge.side !== drag.side || edge.offset !== drag.offset) setDrag({ ...drag, ...edge, moved: true });
    } else if (drag.kind === "marquee") {
      setDrag({ ...drag, end: point });
    }
  });

  const marqueeRect = (from: Point, to: Point) => ({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) });

  const marqueeHits = (rect: { x: number; y: number; w: number; h: number }) =>
    Object.entries(layout?.nodes ?? {})
      .filter(([id, node]) => snapshot.blocks[id] && !removed(id) && intersects(rect, node))
      .map(([id]) => id);

  const onDragEnd = useEffectEvent(() => {
    if (!drag) return;
    cancelAnimationFrame(moveFrame.current);
    if (pendingMove.current) onDragMove(pendingMove.current);
    pendingMove.current = null;
    setDrag(null);
    if (drag.kind === "move") {
      if (drag.moved) {
        const rects: Record<string, NodeRect> = {};
        for (const id of drag.ids) rects[id] = { ...drag.origins[id], x: drag.origins[id].x + drag.dx, y: drag.origins[id].y + drag.dy };
        commitRects(rects);
      } else if (drag.collapseTo) selectOnly([drag.collapseTo]);
    } else if (drag.kind === "resize" && drag.moved) {
      commitRects({ [drag.id]: drag.rect });
    } else if (drag.kind === "connect" && drag.target && layout) {
      const target = layout.nodes[drag.target];
      openPopover({
        kind: "connect",
        from: drag.from,
        to: drag.target,
        fromSide: drag.side,
        toSide: nearestEdge(target, drag.point).side,
        x: drag.point.x,
        y: drag.point.y,
      });
    } else if (drag.kind === "port" && drag.moved && session) {
      const { block, port, side, offset } = drag;
      const key = `${block}/${port}`;
      setOverrides((current) => ({ ...current, ports: { ...current.ports, [key]: { side, offset } } }));
      void session.submit({ op: "movePort", block, port, side, offset }).then((result) => {
        if (result.ok) return;
        setOverrides((current) => {
          const next = { ...current.ports };
          delete next[key];
          return { ...current, ports: next };
        });
      });
    } else if (drag.kind === "marquee") {
      const rect = marqueeRect(drag.start, drag.end);
      const k = viewRef.current.k;
      if (rect.w * k < DRAG_PX && rect.h * k < DRAG_PX) {
        if (!drag.additive) selectOnly([]);
        return;
      }
      const hits = marqueeHits(rect);
      const next = [...new Set([...drag.base, ...hits])];
      selectOnly(next, next.includes(selectedId ?? "") ? selectedId : next.at(-1));
    }
  });

  // A drag listens on the window, so it carries on outside the block it
  // started on. Moves are coalesced to one per animation frame.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      pendingMove.current = event;
      if (moveFrame.current) return;
      moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = 0;
        const latest = pendingMove.current;
        pendingMove.current = null;
        if (latest) onDragMove(latest);
      });
    };
    const end = () => onDragEnd();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);

  const panning = tool === "hand" || spaceHeld;

  const beginDrag = (next: Drag) => {
    setPopover(null);
    setDrag(next);
  };

  const placeBlock = (clientX: number, clientY: number) => {
    const point = toCanvas(clientX, clientY);
    openPopover({ kind: "add", x: Math.max(0, point.x - 120), y: Math.max(0, point.y - 60) });
    setTool("select");
  };

  // Handlers for the memoised blocks. They read the latest render through a
  // ref so the object passed down never changes identity.
  const live = {
    pointerDown(event: React.PointerEvent, id: string) {
      if (event.button === 1 || panning) {
        event.stopPropagation();
        startPan(event);
        return;
      }
      if (event.button !== 0) return;
      event.stopPropagation();
      frameRef.current?.focus({ preventScroll: true });
      setSelectedConnection(null);
      if (tool === "add") {
        placeBlock(event.clientX, event.clientY);
        return;
      }
      if (!editing) {
        selectOnly([id]);
        return;
      }
      const current = selection.filter(onCanvas);
      let ids: string[];
      let collapseTo: string | null = null;
      if (event.shiftKey) {
        if (current.includes(id)) {
          const rest = current.filter((item) => item !== id);
          selectOnly(rest, selectedId === id ? rest.at(-1) ?? null : selectedId);
          return;
        }
        ids = [...current, id];
        selectOnly(ids, id);
      } else if (current.includes(id)) {
        ids = current;
        if (current.length > 1) collapseTo = id;
        if (selectedId !== id) onSelect(id);
      } else {
        ids = [id];
        selectOnly(ids);
      }
      const movable = ids.filter(editable);
      if (!movable.length || !movable.includes(id)) return;
      const origins = Object.fromEntries(movable.map((item) => [item, base!.nodes[item]]));
      beginDrag({ kind: "move", ids: movable, start: toCanvas(event.clientX, event.clientY), origins, dx: 0, dy: 0, moved: false, guides: [], collapseTo });
    },
    doubleClick(event: React.MouseEvent, id: string) {
      event.stopPropagation();
      if (snapshot.layouts[id] && snapshot.blocks[id]?.childIds.length) onEnter(id);
    },
    keyDown(event: React.KeyboardEvent, id: string) {
      if (event.key === "Enter" && event.altKey) {
        if (!snapshot.layouts[id] || !snapshot.blocks[id]?.childIds.length) return;
        event.preventDefault();
        event.stopPropagation();
        onEnter(id);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        selectOnly([id]);
      }
    },
    portPointerDown(event: React.PointerEvent, id: string, port: ViewPort) {
      if (!editing || event.button !== 0 || panning) return;
      event.stopPropagation();
      beginDrag({ kind: "port", block: id, port: port.id, side: port.side, offset: port.offset, moved: false });
    },
    connectPointerDown(event: React.PointerEvent, id: string, side: Side, point: Point) {
      if (!editing || event.button !== 0 || panning) return;
      event.stopPropagation();
      beginDrag({ kind: "connect", from: id, side, point, target: null });
    },
    selectChild(id: string) {
      selectOnly([id]);
    },
  };
  const liveRef = useRef(live);
  useLayoutEffect(() => {
    liveRef.current = live;
  });
  const handlers = useMemo<NodeHandlers>(
    () => ({
      pointerDown: (event, id) => liveRef.current.pointerDown(event, id),
      doubleClick: (event, id) => liveRef.current.doubleClick(event, id),
      keyDown: (event, id) => liveRef.current.keyDown(event, id),
      portPointerDown: (event, id, port) => liveRef.current.portPointerDown(event, id, port),
      connectPointerDown: (event, id, side, point) => liveRef.current.connectPointerDown(event, id, side, point),
      selectChild: (id) => liveRef.current.selectChild(id),
    }),
    [],
  );

  /** Empty canvas: pan, place a block, or draw a selection box. */
  const onFramePointerDown = (event: React.PointerEvent) => {
    if ((event.target as Element).closest("[data-diagram-node], [data-no-pan]")) return;
    frameRef.current?.focus({ preventScroll: true });
    setPopover(null);
    const left = event.button === 0;
    if (event.button === 1 || panning || (left && !editing)) {
      if (event.button === 1) event.preventDefault();
      startPan(event, (moved) => {
        if (!moved && left && !panning) selectOnly([]);
      });
      return;
    }
    if (!left) return;
    if (tool === "add") {
      placeBlock(event.clientX, event.clientY);
      return;
    }
    const point = toCanvas(event.clientX, event.clientY);
    beginDrag({ kind: "marquee", start: point, end: point, additive: event.shiftKey, base: event.shiftKey ? selection.filter(onCanvas) : [] });
  };

  /** Double-click on empty canvas: a new block there. */
  const onDoubleClick = (event: React.MouseEvent) => {
    if (!editing || (event.target as Element).closest("[data-diagram-node], [data-no-pan]")) return;
    placeBlock(event.clientX, event.clientY);
  };

  const onHandle = (event: React.PointerEvent, handle: Handle) => {
    const [id] = selection.filter(editable);
    if (!id || event.button !== 0 || panning) return;
    event.stopPropagation();
    const origin = base!.nodes[id];
    beginDrag({ kind: "resize", id, handle, start: toCanvas(event.clientX, event.clientY), origin, rect: origin, moved: false, guides: [] });
  };

  const selectionRects = selection.flatMap((id) => (layout?.nodes[id] ? [layout.nodes[id]] : []));
  const zoomToSelection = selectionRects.length ? () => zoomToRect(boundsOf(selectionRects)!) : null;

  // Arrows nudge a selection while editing and pan otherwise; zoom keys work
  // whenever the canvas has focus.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (typing(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      if (drag) setDrag(null);
      else if (popover) setPopover(null);
      else if (tool !== "select") setTool("select");
      else selectOnly([]);
      return;
    }
    if (editing && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      deleteSelection();
      return;
    }
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const all = Object.keys(layout?.nodes ?? {}).filter((id) => snapshot.blocks[id] && !removed(id));
      selectOnly(all, all.includes(selectedId ?? "") ? selectedId : all[0]);
      return;
    }
    if (event.shiftKey && !mod && ["Digit1", "Digit2", "Digit0"].includes(event.code)) {
      event.preventDefault();
      if (event.code === "Digit1") fit();
      else if (event.code === "Digit2") zoomToSelection?.();
      else zoomTo(1);
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[event.key];
    if (arrow && !event.altKey && !mod) {
      event.preventDefault();
      if (editing && selection.some(editable)) {
        const step = event.shiftKey ? 50 : GRID;
        nudge(arrow[0] * step, arrow[1] * step);
      } else {
        const step = event.shiftKey ? 120 : 40;
        panBy(-arrow[0] * step, -arrow[1] * step);
      }
      return;
    }
    const zoomKeys: Record<string, () => void> = {
      "+": () => zoomBy(1.25),
      "=": () => zoomBy(1.25),
      "-": () => zoomBy(1 / 1.25),
      _: () => zoomBy(1 / 1.25),
      "0": () => fit(),
    };
    const action = !mod ? zoomKeys[event.key] : undefined;
    if (!action) return;
    event.preventDefault();
    action();
  };

  // Tool keys and Space-to-pan, from anywhere on the page that is not a field.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (typing(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const inCanvas = !(event.target instanceof HTMLElement) || event.target === document.body || Boolean(frameRef.current?.contains(event.target));
      if (event.code === "Space") {
        if (!inCanvas) return;
        event.preventDefault();
        if (!event.repeat) setSpaceHeld(true);
        return;
      }
      if (event.repeat || !inCanvas) return;
      const key = event.key.toLowerCase();
      if (key === "v") setTool("select");
      else if (key === "h") setTool("hand");
      else if (key === "b" && editing) setTool("add");
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [editing, frameRef]);

  // Bring the selection into view when it arrives from the tree, a connection
  // link, or a deep link rather than from a click on the canvas.
  //
  // Skipped on the render where the canvas changed: the camera frames the
  // whole canvas there, and centring as well would race it.
  const fittedFocus = useRef<string | null>(null);
  useEffect(() => {
    const changedCanvas = fittedFocus.current !== focusId;
    fittedFocus.current = focusId;
    if (changedCanvas || !selectedId) return;
    const rect = layoutRef.current?.nodes[selectedId];
    if (rect) revealRect(rect);
    // Keyed on selection and focus only: re-running on every change would
    // fight the user's own panning.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, focusId]);

  const focusBlock = snapshot.blocks[focusId];
  const marquee = drag?.kind === "marquee" ? marqueeRect(drag.start, drag.end) : null;
  const marqueeSelection = drag?.kind === "marquee" && marquee ? new Set([...drag.base, ...marqueeHits(marquee)]) : null;
  const shownSelection = marqueeSelection ?? new Set(selection);
  const overlayRects = [...shownSelection].flatMap((id) => (layout?.nodes[id] ? [layout.nodes[id]] : []));
  const guides = drag?.kind === "move" || drag?.kind === "resize" ? drag.guides : [];
  const resizable = editing && !drag && selection.length === 1 && selection.every(editable);
  const toolClass = panning ? " tool-hand" : tool === "add" ? " tool-add" : "";

  return (
    <div className="diagram-shell">
      <div
        ref={frameRef}
        className={`diagram-frame${dragPanning ? " panning" : ""}${editing ? " editing" : ""}${toolClass}${drag ? ` dragging-${drag.kind}` : ""}`}
        tabIndex={0}
        role="application"
        aria-label={`Architecture diagram for ${focusBlock?.name ?? focusId}. Scroll or Space-drag to pan, pinch or Ctrl-scroll to zoom, Shift+1 fits.`}
        onKeyDown={onKeyDown}
        onPointerDown={onFramePointerDown}
        onDoubleClick={onDoubleClick}
      >
        <svg className="diagram-svg" width="100%" height="100%" role="presentation">
          <defs>
            <pattern id={gridId} ref={gridRef} patternUnits="userSpaceOnUse" width={GRID} height={GRID}>
              <circle className="grid-dot" cx={GRID / 2} cy={GRID / 2} r={1} />
            </pattern>
          </defs>
          <rect className="diagram-grid" width="100%" height="100%" fill={`url(#${gridId})`} />
          <g ref={layerRef}>
            <g className="edge-layer">
              {edges.map(({ connection, d, color }) => {
                const emphasis = edgeEmphasis(connection.protocol, connection.from, connection.to);
                const linked = selectedId === connection.from || selectedId === connection.to;
                return (
                  <g
                    key={connection.id}
                    className={`edge emphasis-${emphasis}${linked ? " linked" : ""}${changes?.connections[connection.id] ? ` diff-${changes.connections[connection.id]}` : ""}${selectedConnection === connection.id ? " selected" : ""}`}
                    data-no-pan={editing ? "" : undefined}
                    onPointerDown={editing ? (event) => event.stopPropagation() : undefined}
                    onClick={
                      editing
                        ? (event) => {
                            event.stopPropagation();
                            setSelection([]);
                            setSelectedConnection(connection.id);
                            frameRef.current?.focus({ preventScroll: true });
                          }
                        : undefined
                    }
                  >
                    {editing && <path className="edge-hit" d={d} />}
                    <path className="edge-line" d={d} style={{ stroke: color }} />
                    <title>{`${snapshot.blocks[connection.from]?.name} → ${snapshot.blocks[connection.to]?.name} · ${connection.label}`}</title>
                  </g>
                );
              })}
            </g>

            <g className="node-layer">
              {nodes.map(({ id, rect, block }) => (
                <CanvasNode
                  key={id}
                  id={id}
                  rect={rect}
                  block={block}
                  snapshot={snapshot}
                  ports={ports[id]}
                  emphasis={nodeEmphasis(id)}
                  selected={shownSelection.has(id)}
                  selectedChild={selectedId && snapshot.blocks[selectedId]?.parent === id ? selectedId : null}
                  diffClass={diffClass}
                  diffStatus={changes?.blocks[id]}
                  zoom={zoom}
                  readiness={lens.kind === "readiness"}
                  dimProtocol={lens.kind === "protocol" ? lens.protocol : null}
                  editing={editing}
                  removed={removed(id)}
                  connectTarget={drag?.kind === "connect" && drag.target === id}
                  handlers={handlers}
                />
              ))}
            </g>

            <SelectionOverlay rects={overlayRects} zoom={zoom} resizable={resizable} guides={guides} marquee={marquee} onHandle={onHandle} />

            {drag?.kind === "connect" && layout?.nodes[drag.from] && (
              <line
                className="connect-rubber"
                x1={layout.nodes[drag.from].x + handlePoint(drag.side, layout.nodes[drag.from]).x}
                y1={layout.nodes[drag.from].y + handlePoint(drag.side, layout.nodes[drag.from]).y}
                x2={drag.point.x}
                y2={drag.point.y}
              />
            )}
          </g>
        </svg>
        {!layout && <p className="diagram-missing">This block has no authored canvas. Its record is in the inspector.</p>}
      </div>

      {editing && selectedConnection && session && snapshot.connections.some((item) => item.id === selectedConnection) && (
        <div className="canvas-connection-bar" data-no-pan>
          <span>{describe(snapshot, selectedConnection)}</span>
          <ConnectionEditor
            key={selectedConnection}
            connection={snapshot.connections.find((item) => item.id === selectedConnection)!}
            session={session}
          />
          <button type="button" className="canvas-connection-close" onClick={() => setSelectedConnection(null)} aria-label="Deselect connection">
            <Icon name="close" />
          </button>
        </div>
      )}

      {popover && session && (
        <CanvasPopoverView
          key={`${popover.kind}-${popover.x}-${popover.y}`}
          popover={popover}
          snapshot={snapshot}
          focusId={focusId}
          session={session}
          position={popover.screen}
          onClose={() => {
            setPopover(null);
            frameRef.current?.focus({ preventScroll: true });
          }}
        />
      )}

      <CanvasToolbar
        tool={panning && tool !== "hand" ? "hand" : tool}
        onTool={(next) => {
          setTool(next);
          frameRef.current?.focus({ preventScroll: true });
        }}
        editing={editing}
        canLeave={canLeave}
        onLeave={onLeave}
        zoom={zoom}
        onZoomIn={() => zoomBy(1.25)}
        onZoomOut={() => zoomBy(1 / 1.25)}
        onZoomTo={zoomTo}
        onFit={() => fit()}
        onZoomToSelection={zoomToSelection}
        canUndo={Boolean(session?.canUndo)}
        onUndo={() => session?.undo()}
      />
    </div>
  );
}
