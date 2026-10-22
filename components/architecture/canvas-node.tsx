"use client";

import { memo } from "react";
import { SIDES, type Side } from "@/lib/model/schema";
import type { ViewBlock, ViewLayout, ViewPort, ViewSnapshot } from "@/lib/model/view";
import { MATURITY_COLOR } from "./lens";
import type { Guide } from "./snapping";

export type NodeRect = ViewLayout["nodes"][string];
export type Point = { x: number; y: number };
export type Emphasis = "active" | "dim" | "normal";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const DIFF_TAG = { added: "NEW", removed: "REMOVED", changed: "CHANGED" } as const;

/**
 * Semantic zoom.
 *
 * Canvas text scales with the view, so at fit-zoom a 15px title rasterises to
 * about 5px of grey mush. Labels are therefore sized in screen pixels and
 * converted back into canvas units, and detail is gated on how large a block
 * actually is on screen rather than on a single global zoom threshold — a
 * large composite can show its modules at the same zoom where a small one
 * cannot.
 */
const DETAIL_MIN_W = 132;
const DETAIL_MIN_H = 64;
const MIN_LABEL_PX = 10.5;
/** Screen size a nested module label renders at, whenever it renders at all. */
const MODULE_LABEL_PX = 9;
const RADIUS = 6;

/**
 * SVG text neither wraps nor ellipsises, and clipping cuts glyphs mid-stroke.
 * This trims to what actually fits and marks the cut, returning null when even
 * a few characters would not fit — an unlabelled module still reads as
 * composition, a half-glyph does not.
 */
function fitLabel(text: string, available: number, fontSize: number, minChars = 4): string | null {
  const charWidth = fontSize * 0.55;
  const maxChars = Math.floor(available / charWidth);
  if (maxChars < minChars) return null;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Where a port sits on its block's edge, relative to the block. */
function portAt(side: Side, rect: { w: number; h: number }, offset: number): Point {
  if (side === "left") return { x: 0, y: rect.h * offset };
  if (side === "right") return { x: rect.w, y: rect.h * offset };
  if (side === "top") return { x: rect.w * offset, y: 0 };
  return { x: rect.w * offset, y: rect.h };
}

/**
 * Where a side's connection handle sits, relative to the block: just outside
 * the middle of the edge, so it never covers a port that can be dragged.
 */
export function handlePoint(side: Side, rect: { w: number; h: number }, out = 0): Point {
  if (side === "left") return { x: -out, y: rect.h / 2 };
  if (side === "right") return { x: rect.w + out, y: rect.h / 2 };
  if (side === "top") return { x: rect.w / 2, y: -out };
  return { x: rect.w / 2, y: rect.h + out };
}

/** A rectangle with only its top corners rounded: the header band. */
function headerPath(w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h);
  return `M0 ${h} V${radius} Q0 0 ${radius} 0 H${w - radius} Q${w} 0 ${w} ${radius} V${h} Z`;
}

/** The light maturity wash on a header; stronger under the readiness lens. */
function headerTint(maturity: ViewBlock["maturity"], strong: boolean) {
  return `color-mix(in srgb, ${MATURITY_COLOR[maturity]} ${strong ? 22 : 9}%, #ffffff)`;
}

/**
 * One level of a composite's children, mapped from its own authored canvas
 * into the body of the parent block. Only one level is drawn: deeper nesting
 * stops being legible and starts being texture.
 */
function NodeInternals({
  snapshot,
  layout,
  rect,
  headerHeight,
  selectedChild,
  zoom,
  onSelect,
  diffClass,
}: {
  snapshot: ViewSnapshot;
  layout: ViewLayout;
  rect: { w: number; h: number };
  headerHeight: number;
  selectedChild: string | null;
  zoom: number;
  diffClass(id: string): string;
  onSelect(id: string): void;
}) {
  const padX = 9;
  const padBottom = 9;
  const innerW = rect.w - padX * 2;
  const innerH = rect.h - headerHeight - padBottom - 6;
  if (innerW < 24 || innerH < 18) return null;

  const sx = innerW / layout.canvas.width;
  const sy = innerH / layout.canvas.height;

  return (
    <g className="node-internals" transform={`translate(${padX} ${headerHeight + 6})`}>
      {Object.entries(layout.nodes).map(([childId, child]) => {
        const block = snapshot.blocks[childId];
        if (!block) return null;
        const w = child.w * sx;
        const h = child.h * sy;
        const labelSize = MODULE_LABEL_PX / zoom;
        const label = h * zoom >= 15 ? fitLabel(block.name, w - 9, labelSize, 3) : null;
        return (
          <g
            key={childId}
            className={`internal-node${childId === selectedChild ? " selected" : ""}${block.childIds.length ? " composite" : ""}${label ? "" : " unlabelled"}${diffClass(childId)}`}
            transform={`translate(${child.x * sx} ${child.y * sy})`}
            role="button"
            tabIndex={-1}
            aria-label={block.name}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(childId);
            }}
          >
            <rect width={w} height={h} rx={3} />
            <title>{block.name}</title>
            {label && (
              <text x={5} y={labelSize * 0.82 + 5} style={{ fontSize: labelSize }}>
                {label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Handlers are passed as one stable object so a memoised node never re-renders for them. */
export type NodeHandlers = {
  pointerDown(event: React.PointerEvent, id: string): void;
  doubleClick(event: React.MouseEvent, id: string): void;
  keyDown(event: React.KeyboardEvent, id: string): void;
  portPointerDown(event: React.PointerEvent, id: string, port: ViewPort): void;
  connectPointerDown(event: React.PointerEvent, id: string, side: Side, point: Point): void;
  selectChild(id: string): void;
};

type NodeProps = {
  id: string;
  rect: NodeRect;
  block: ViewBlock;
  snapshot: ViewSnapshot;
  ports: ViewPort[] | undefined;
  emphasis: Emphasis;
  selected: boolean;
  /** The selected block when it is one of this composite's modules. */
  selectedChild: string | null;
  diffClass(id: string): string;
  diffStatus: "added" | "removed" | "changed" | undefined;
  zoom: number;
  readiness: boolean;
  dimProtocol: string | null;
  editing: boolean;
  removed: boolean;
  connectTarget: boolean;
  handlers: NodeHandlers;
};

export const CanvasNode = memo(function CanvasNode({
  id,
  rect,
  block,
  snapshot,
  ports,
  emphasis,
  selected,
  selectedChild,
  diffClass,
  diffStatus,
  zoom,
  readiness,
  dimProtocol,
  editing,
  removed,
  connectTarget,
  handlers,
}: NodeProps) {
  const layout = snapshot.layouts[id];
  const enterable = Boolean(layout) && block.childIds.length > 0;
  const titleSize = Math.max(8, Math.min(15, Math.min(rect.w / 12, rect.h / 3.2)));
  // Keep the name legible when zoomed out. The header grows with it so the
  // modules below are never overlapped by the title.
  const renderedTitle = Math.max(titleSize, MIN_LABEL_PX / zoom);
  const topPortInset = (ports ?? []).some((port) => port.side === "top") && zoom >= 0.72 ? 12 : 0;
  const headerHeight = Math.min(rect.h, renderedTitle + 16 + topPortInset);
  const hasInternals = enterable && rect.w * zoom > DETAIL_MIN_W && rect.h * zoom > DETAIL_MIN_H && rect.h - headerHeight > 24;
  const dot = renderedTitle * 0.26;
  const titleX = 10 + dot * 2 + renderedTitle * 0.4;
  const showPortLabels = zoom >= 0.72;

  return (
    <g
      className={`diagram-node emphasis-${emphasis}${selected ? " selected" : ""}${diffClass(id)}${connectTarget ? " connect-target" : ""}`}
      data-diagram-node={id}
      transform={`translate(${rect.x} ${rect.y})`}
      tabIndex={0}
      role="button"
      aria-label={`${block.name}, ${block.kind}, ${block.maturity}${enterable ? ", composite, Alt+Enter to open" : ""}`}
      aria-pressed={selected}
      onPointerDown={(event) => handlers.pointerDown(event, id)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => handlers.doubleClick(event, id)}
      onKeyDown={(event) => handlers.keyDown(event, id)}
    >
      <rect className="node-body" width={rect.w} height={rect.h} rx={RADIUS} />
      <path className="node-header" d={headerPath(rect.w, headerHeight, RADIUS)} style={{ fill: headerTint(block.maturity, readiness) }} />
      {headerHeight < rect.h && <line className="node-rule" x1={0} y1={headerHeight} x2={rect.w} y2={headerHeight} />}
      <circle className="node-maturity" cx={10 + dot} cy={topPortInset + (headerHeight - topPortInset) / 2} r={dot} style={{ fill: MATURITY_COLOR[block.maturity] }} />
      {/* SVG text neither wraps nor ellipsises, so a long name is trimmed
          to its own block rather than bleeding across the canvas. */}
      <text
        className="node-title"
        x={titleX}
        y={topPortInset + (headerHeight - topPortInset) / 2 + renderedTitle * 0.35}
        style={{ fontSize: renderedTitle }}
      >
        {fitLabel(block.name, rect.w - titleX - (enterable ? 22 : 8), renderedTitle, 3) ?? ""}
      </text>
      {hasInternals && (
        <NodeInternals
          snapshot={snapshot}
          layout={layout}
          rect={rect}
          headerHeight={headerHeight}
          selectedChild={selectedChild}
          zoom={zoom}
          onSelect={handlers.selectChild}
          diffClass={diffClass}
        />
      )}
      {diffStatus && rect.h * zoom > 34 && (
        <text className="node-diff-tag" x={9} y={rect.h - 8} style={{ fontSize: 9 / zoom }}>
          {DIFF_TAG[diffStatus]}
        </text>
      )}
      {enterable && (
        <g className="node-enter" transform={`translate(${rect.w - 18} ${topPortInset + (headerHeight - topPortInset) / 2 - 5})`} aria-hidden="true">
          <path d="M2 1.5 6 5 2 8.5" />
        </g>
      )}
      {(ports ?? []).map((port) => {
        const color = snapshot.protocols[port.protocol]?.color ?? "var(--muted)";
        const at = portAt(port.side, rect, port.offset);
        const horizontal = port.side === "left" || port.side === "right";
        const dim = dimProtocol !== null && port.protocol !== dimProtocol;
        return (
          <g
            key={port.id}
            className={`node-port${dim ? " dim" : ""}`}
            onPointerDown={(event) => {
              if (!removed) handlers.portPointerDown(event, id, port);
            }}
          >
            {editing && <circle className="port-hit" cx={at.x} cy={at.y} r={9} />}
            <circle className="port-dot" cx={at.x} cy={at.y} r={3.6} style={{ fill: color }} />
            {showPortLabels && (
              <text
                className="port-label"
                x={horizontal ? (port.side === "left" ? 9 : rect.w - 9) : at.x}
                y={horizontal ? at.y + 2.6 : port.side === "top" ? 11 : rect.h - 6}
                textAnchor={horizontal ? (port.side === "left" ? "start" : "end") : "middle"}
              >
                {port.label}
              </text>
            )}
            <title>{port.label}</title>
          </g>
        );
      })}
      {editing && !removed && (
        <g className="edit-handles" data-no-pan>
          {SIDES.map((side) => {
            const point = handlePoint(side, rect, 14 / zoom);
            return (
              <circle
                key={side}
                className="connect-handle"
                cx={point.x}
                cy={point.y}
                r={5 / zoom}
                onPointerDown={(event) => handlers.connectPointerDown(event, id, side, { x: rect.x + point.x, y: rect.y + point.y })}
              >
                <title>Drag to another block to connect</title>
              </circle>
            );
          })}
        </g>
      )}
    </g>
  );
});

/**
 * Selection, guides, and the marquee, drawn above the blocks in canvas units
 * but sized in screen pixels, so handles stay the same size at every zoom.
 */
export function SelectionOverlay({
  rects,
  zoom,
  resizable,
  guides,
  marquee,
  onHandle,
}: {
  rects: NodeRect[];
  zoom: number;
  /** Handles show for a single editable selection. */
  resizable: boolean;
  guides: Guide[];
  marquee: { x: number; y: number; w: number; h: number } | null;
  onHandle(event: React.PointerEvent, handle: Handle): void;
}) {
  const size = 8 / zoom;
  const single = rects.length === 1 ? rects[0] : null;
  return (
    <g className="selection-overlay">
      {rects.map((rect, index) => (
        <rect key={index} className="selection-ring" x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={RADIUS} />
      ))}
      {single && resizable &&
        HANDLES.map((handle) => {
          const x = single.x + (handle.includes("w") ? 0 : handle.includes("e") ? single.w : single.w / 2);
          const y = single.y + (handle.includes("n") ? 0 : handle.includes("s") ? single.h : single.h / 2);
          return (
            <rect
              key={handle}
              className={`resize-handle handle-${handle}`}
              x={x - size / 2}
              y={y - size / 2}
              width={size}
              height={size}
              rx={1.5 / zoom}
              data-no-pan
              onPointerDown={(event) => onHandle(event, handle)}
            />
          );
        })}
      {guides.map((guide, index) =>
        guide.axis === "x" ? (
          <line key={index} className="snap-guide" x1={guide.at} x2={guide.at} y1={guide.from} y2={guide.to} />
        ) : (
          <line key={index} className="snap-guide" y1={guide.at} y2={guide.at} x1={guide.from} x2={guide.to} />
        ),
      )}
      {marquee && <rect className="marquee" x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} />}
    </g>
  );
}
