"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export type Viewport = { x: number; y: number; k: number };
type Rect = { x: number; y: number; w: number; h: number };
export type Insets = { left: number; right: number; top: number; bottom: number };

const MIN_SCALE = 0.05;
const MAX_SCALE = 8;
const FIT_MAX_SCALE = 1.5;
const PAD = 40;
const DURATION = 240;
/** How long after the last change the zoom level is handed to React. */
const SETTLE_MS = 110;
/** Grid dots stay at least this far apart on screen; the step doubles until they are. */
const MIN_DOT_GAP = 14;
const DOT_STEP = 10;

const NO_INSETS: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * The last view of each canvas. A commit refreshes the page, and the refresh
 * can remount the canvas; without this every edit would throw away where
 * someone had panned and zoomed to.
 */
const remembered = new Map<string, Viewport>();

function clampScale(k: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, k));
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Wheel deltas in pixels, whatever unit the device reported them in. */
function wheelPixels(event: WheelEvent, page: number) {
  const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1;
  return { dx: event.deltaX * scale, dy: event.deltaY * scale };
}

type Options = {
  /** The canvas-space box that "fit" frames: the blocks, not the authored canvas size. */
  bounds(): Rect | null;
  /** Screen space covered by floating panels, which fit and reveal avoid. */
  insets?(): Insets;
  /** Which canvas is drawn. Changing it frames the new canvas. */
  focusKey: string;
};

/**
 * The canvas camera: pan and zoom.
 *
 * The view lives in a ref and is written straight onto the SVG transform once
 * per animation frame, so panning and zooming never re-render React. Only the
 * zoom level is handed to React, after a gesture settles, for the level of
 * detail that depends on it (label sizes, port labels, a composite's insides).
 *
 * Trackpads pan with two fingers and zoom with a pinch (which browsers report
 * as a wheel event with ctrlKey); a mouse wheel pans, and zooms with Ctrl/⌘.
 * Fit, reveal, and the zoom controls animate; reduced motion jumps instead.
 */
export function useCamera({ bounds, insets, focusKey }: Options) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);
  const gridRef = useRef<SVGPatternElement | null>(null);
  const viewRef = useRef<Viewport>({ x: 0, y: 0, k: 1 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const raf = useRef(0);
  const animation = useRef(0);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const listeners = useRef(new Set<(view: Viewport) => void>());
  const options = useRef({ bounds, insets });
  const keyRef = useRef(focusKey);
  /** Set once the first view is placed; only placed views are remembered. */
  const placed = useRef(false);
  useLayoutEffect(() => {
    options.current = { bounds, insets };
  });

  const write = useCallback(() => {
    raf.current = 0;
    const view = viewRef.current;
    if (placed.current) remembered.set(keyRef.current, view);
    layerRef.current?.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.k})`);
    const grid = gridRef.current;
    if (grid) {
      let step = DOT_STEP;
      while (step * view.k < MIN_DOT_GAP) step *= 2;
      grid.setAttribute("width", String(step));
      grid.setAttribute("height", String(step));
      grid.setAttribute("x", String(-step / 2));
      grid.setAttribute("y", String(-step / 2));
      grid.setAttribute("patternTransform", `translate(${view.x} ${view.y}) scale(${view.k})`);
      const dot = grid.firstElementChild;
      dot?.setAttribute("cx", String(step / 2));
      dot?.setAttribute("cy", String(step / 2));
      dot?.setAttribute("r", String(1 / view.k));
    }
    for (const listener of listeners.current) listener(view);
  }, []);

  const schedule = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(write);
  }, [write]);

  // Keep the DOM in step whenever React re-renders the layer (a remount
  // would otherwise draw it untransformed for a frame).
  useLayoutEffect(() => {
    write();
  });

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      cancelAnimationFrame(animation.current);
      clearTimeout(settle.current);
    },
    [],
  );

  const settleZoom = useCallback((immediate = false) => {
    clearTimeout(settle.current);
    if (immediate) setZoom(viewRef.current.k);
    else settle.current = setTimeout(() => setZoom(viewRef.current.k), SETTLE_MS);
  }, []);

  const jump = useCallback(
    (next: Viewport) => {
      cancelAnimationFrame(animation.current);
      const k = clampScale(next.k);
      const changedZoom = k !== viewRef.current.k;
      viewRef.current = { x: next.x, y: next.y, k };
      schedule();
      if (changedZoom) settleZoom();
    },
    [schedule, settleZoom],
  );

  /**
   * Animate to a view. The point at the middle of the frame travels in a
   * straight line while the scale changes geometrically, which reads as one
   * smooth move rather than a zoom that drifts sideways.
   */
  const animateTo = useCallback(
    (target: Viewport) => {
      cancelAnimationFrame(animation.current);
      const frame = frameRef.current;
      const to = { ...target, k: clampScale(target.k) };
      if (!frame || reducedMotion()) {
        jump(to);
        settleZoom(true);
        return;
      }
      const from = viewRef.current;
      const cx = frame.clientWidth / 2;
      const cy = frame.clientHeight / 2;
      const centreFrom = { x: (cx - from.x) / from.k, y: (cy - from.y) / from.k };
      const centreTo = { x: (cx - to.x) / to.k, y: (cy - to.y) / to.k };
      const began = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - began) / DURATION);
        const e = easeOut(t);
        const k = from.k * (to.k / from.k) ** e;
        const centre = { x: centreFrom.x + (centreTo.x - centreFrom.x) * e, y: centreFrom.y + (centreTo.y - centreFrom.y) * e };
        viewRef.current = t < 1 ? { k, x: cx - centre.x * k, y: cy - centre.y * k } : to;
        write();
        if (t < 1) animation.current = requestAnimationFrame(step);
        else settleZoom(true);
      };
      animation.current = requestAnimationFrame(step);
    },
    [jump, settleZoom, write],
  );

  const stopAnimation = useCallback(() => cancelAnimationFrame(animation.current), []);

  const visibleArea = useCallback(() => {
    const frame = frameRef.current;
    const inset = options.current.insets?.() ?? NO_INSETS;
    if (!frame) return null;
    return {
      left: inset.left,
      top: inset.top,
      width: Math.max(80, frame.clientWidth - inset.left - inset.right),
      height: Math.max(80, frame.clientHeight - inset.top - inset.bottom),
    };
  }, []);

  /** The view that frames a canvas rect inside the visible area. */
  const framing = useCallback(
    (rect: Rect, maxScale = FIT_MAX_SCALE): Viewport | null => {
      const area = visibleArea();
      if (!area || !frameRef.current?.clientWidth) return null;
      const k = clampScale(Math.min((area.width - PAD * 2) / Math.max(rect.w, 1), (area.height - PAD * 2) / Math.max(rect.h, 1), maxScale));
      return {
        k,
        x: area.left + (area.width - rect.w * k) / 2 - rect.x * k,
        y: area.top + (area.height - rect.h * k) / 2 - rect.y * k,
      };
    },
    [visibleArea],
  );

  const fit = useCallback(
    (animate = true) => {
      const box = options.current.bounds();
      const view = box && framing(box);
      if (!view) return;
      if (animate) animateTo(view);
      else {
        jump(view);
        settleZoom(true);
      }
    },
    [animateTo, framing, jump, settleZoom],
  );

  const zoomToRect = useCallback(
    (rect: Rect) => {
      const view = framing(rect, 2);
      if (view) animateTo(view);
    },
    [animateTo, framing],
  );

  const zoomAround = useCallback(
    (k: number, origin: { x: number; y: number }, animate: boolean) => {
      const current = viewRef.current;
      const next = clampScale(k);
      const ratio = next / current.k;
      const view = { k: next, x: origin.x - (origin.x - current.x) * ratio, y: origin.y - (origin.y - current.y) * ratio };
      if (animate) animateTo(view);
      else jump(view);
    },
    [animateTo, jump],
  );

  const centre = useCallback(() => {
    const area = visibleArea();
    return area ? { x: area.left + area.width / 2, y: area.top + area.height / 2 } : { x: 0, y: 0 };
  }, [visibleArea]);

  const zoomBy = useCallback((factor: number) => zoomAround(viewRef.current.k * factor, centre(), true), [zoomAround, centre]);
  const zoomTo = useCallback((k: number) => zoomAround(k, centre(), true), [zoomAround, centre]);

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const view = viewRef.current;
      jump({ ...view, x: view.x + dx, y: view.y + dy });
    },
    [jump],
  );

  /** Bring a canvas rect into the visible area if it is not already there. */
  const revealRect = useCallback(
    (rect: Rect, margin = 48) => {
      const area = visibleArea();
      if (!area) return;
      const view = viewRef.current;
      const cx = (rect.x + rect.w / 2) * view.k + view.x;
      const cy = (rect.y + rect.h / 2) * view.k + view.y;
      const visible =
        cx > area.left + margin && cy > area.top + margin && cx < area.left + area.width - margin && cy < area.top + area.height - margin;
      if (visible) return;
      animateTo({ ...view, x: view.x + area.left + area.width / 2 - cx, y: view.y + area.top + area.height / 2 - cy });
    },
    [animateTo, visibleArea],
  );

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const frame = frameRef.current!.getBoundingClientRect();
    const view = viewRef.current;
    return { x: (clientX - frame.left - view.x) / view.k, y: (clientY - frame.top - view.y) / view.k };
  }, []);

  const subscribe = useCallback((listener: (view: Viewport) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  // Wheel and pinch. Non-passive, because React's onWheel is passive and the
  // page would scroll underneath the canvas.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      if ((event.target as Element | null)?.closest?.("[data-scrollable]")) return;
      event.preventDefault();
      stopAnimation();
      const { dx, dy } = wheelPixels(event, frame.clientHeight);
      if (event.ctrlKey || event.metaKey) {
        // A trackpad pinch arrives as many small ctrl+wheel deltas; a mouse
        // wheel with Ctrl as a few large ones. Both map to the same curve.
        const intensity = Math.abs(dy) < 40 ? 0.011 : 0.0028;
        const rect = frame.getBoundingClientRect();
        zoomAround(viewRef.current.k * Math.exp(-dy * intensity), { x: event.clientX - rect.left, y: event.clientY - rect.top }, false);
        return;
      }
      if (event.shiftKey && !dx) panBy(-dy, 0);
      else panBy(-dx, -dy);
    };
    // Safari reports trackpad pinches as gesture events instead.
    let gestureStart = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStart = viewRef.current.k;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale: number; clientX: number; clientY: number };
      const rect = frame.getBoundingClientRect();
      zoomAround(gestureStart * gesture.scale, { x: gesture.clientX - rect.left, y: gesture.clientY - rect.top }, false);
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    frame.addEventListener("gesturestart", onGestureStart);
    frame.addEventListener("gesturechange", onGestureChange);
    return () => {
      frame.removeEventListener("wheel", onWheel);
      frame.removeEventListener("gesturestart", onGestureStart);
      frame.removeEventListener("gesturechange", onGestureChange);
    };
  }, [panBy, zoomAround, stopAnimation]);

  // Frame the canvas the first time the frame has a size; afterwards a resize
  // keeps whatever was in the middle in the middle, rather than re-fitting
  // and losing the place someone panned to.
  const size = useRef<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const w = frame.clientWidth;
      const h = frame.clientHeight;
      if (!w || !h) return;
      const before = size.current;
      size.current = { w, h };
      if (!before) {
        placed.current = true;
        const saved = remembered.get(keyRef.current);
        if (saved) {
          jump(saved);
          settleZoom(true);
        } else fit(false);
        return;
      }
      const view = viewRef.current;
      jump({ ...view, x: view.x + (w - before.w) / 2, y: view.y + (h - before.h) / 2 });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [fit, jump, settleZoom]);

  // A different canvas is framed whole, with a short move so it is clear
  // where you went.
  const fittedKey = useRef(focusKey);
  useEffect(() => {
    if (fittedKey.current === focusKey) return;
    fittedKey.current = focusKey;
    keyRef.current = focusKey;
    fit(true);
  }, [focusKey, fit]);

  /** Drag-to-pan from a pointer down. `onEnd` learns whether it actually moved. */
  const startPan = useCallback(
    (event: React.PointerEvent, onEnd?: (moved: boolean) => void) => {
      stopAnimation();
      const startX = event.clientX;
      const startY = event.clientY;
      let lastX = startX;
      let lastY = startY;
      let moved = false;
      setPanning(true);
      const move = (next: PointerEvent) => {
        if (!moved && Math.hypot(next.clientX - startX, next.clientY - startY) > 3) moved = true;
        panBy(next.clientX - lastX, next.clientY - lastY);
        lastX = next.clientX;
        lastY = next.clientY;
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        setPanning(false);
        onEnd?.(moved);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [panBy, stopAnimation],
  );

  return {
    frameRef,
    layerRef,
    gridRef,
    /** The live view; read it in handlers, never during render. */
    view: viewRef,
    /** The zoom level React renders detail for; trails the live view slightly during a gesture. */
    zoom,
    panning,
    fit,
    zoomBy,
    zoomTo,
    zoomToRect,
    panBy,
    revealRect,
    toCanvas,
    subscribe,
    startPan,
  };
}

export type Camera = ReturnType<typeof useCamera>;
