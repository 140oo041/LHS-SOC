"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";

export type Tool = "select" | "hand" | "add";

type Props = {
  tool: Tool;
  onTool(tool: Tool): void;
  /** Add and undo only exist while the model can be edited here. */
  editing: boolean;
  canLeave: boolean;
  onLeave(): void;
  zoom: number;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomTo(k: number): void;
  onFit(): void;
  onZoomToSelection: (() => void) | null;
  canUndo: boolean;
  onUndo(): void;
};

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** One floating bar for every canvas control, bottom centre, as in Figma. */
export function CanvasToolbar(props: Props) {
  const { tool, onTool, editing, canLeave, onLeave, zoom, onZoomIn, onZoomOut, onZoomTo, onFit, onZoomToSelection, canUndo, onUndo } = props;
  const [menu, setMenu] = useState<"zoom" | "help" | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menu]);

  const mod = isMac() ? "⌘" : "Ctrl";
  const pick = (action: () => void) => () => {
    action();
    setMenu(null);
  };

  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas tools" ref={ref} data-no-pan onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" className="tool" aria-pressed={tool === "select"} onClick={() => onTool("select")} title="Select (V)" aria-label="Select">
        <Icon name="pointer" />
      </button>
      <button type="button" className="tool" aria-pressed={tool === "hand"} onClick={() => onTool("hand")} title="Hand (H, or hold Space)" aria-label="Hand">
        <Icon name="hand" />
      </button>
      {editing && (
        <button type="button" className="tool" aria-pressed={tool === "add"} onClick={() => onTool(tool === "add" ? "select" : "add")} title="Add block (B)" aria-label="Add block">
          <Icon name="block" />
        </button>
      )}
      <span className="toolbar-rule" aria-hidden="true" />
      <button type="button" className="tool" onClick={onLeave} disabled={!canLeave} title="Up one level (Alt+↑)" aria-label="Up one level">
        <Icon name="level-up" />
      </button>
      <span className="toolbar-rule" aria-hidden="true" />
      <button type="button" className="tool" onClick={onZoomOut} title="Zoom out (−)" aria-label="Zoom out">
        <Icon name="minus" />
      </button>
      <div className="toolbar-menu-anchor">
        <button type="button" className="zoom-readout" aria-haspopup="menu" aria-expanded={menu === "zoom"} onClick={() => setMenu(menu === "zoom" ? null : "zoom")} title="Zoom options">
          {Math.round(zoom * 100)}%
        </button>
        {menu === "zoom" && (
          <div className="toolbar-menu" role="menu">
            <button type="button" role="menuitem" onClick={pick(onFit)}>
              Zoom to fit <kbd>⇧1</kbd>
            </button>
            {onZoomToSelection && (
              <button type="button" role="menuitem" onClick={pick(onZoomToSelection)}>
                Zoom to selection <kbd>⇧2</kbd>
              </button>
            )}
            <hr />
            {[0.5, 1, 2].map((k) => (
              <button key={k} type="button" role="menuitem" onClick={pick(() => onZoomTo(k))}>
                Zoom to {k * 100}% {k === 1 && <kbd>⇧0</kbd>}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="tool" onClick={onZoomIn} title="Zoom in (+)" aria-label="Zoom in">
        <Icon name="plus" />
      </button>
      {editing && (
        <>
          <span className="toolbar-rule" aria-hidden="true" />
          <button type="button" className="tool" onClick={onUndo} disabled={!canUndo} title={`Undo (${mod}+Z)`} aria-label="Undo">
            <Icon name="undo" />
          </button>
        </>
      )}
      <span className="toolbar-rule" aria-hidden="true" />
      <div className="toolbar-menu-anchor">
        <button type="button" className="tool" aria-expanded={menu === "help"} onClick={() => setMenu(menu === "help" ? null : "help")} title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
          <Icon name="help" />
        </button>
        {menu === "help" && (
          <div className="toolbar-menu shortcuts" role="dialog" aria-label="Keyboard shortcuts">
            <dl>
              <div><dt>Pan</dt><dd>Scroll, Space+drag, or H</dd></div>
              <div><dt>Zoom</dt><dd>Pinch, or {mod}+scroll</dd></div>
              <div><dt>Fit · selection · 100%</dt><dd>⇧1 · ⇧2 · ⇧0</dd></div>
              <div><dt>Open a composite</dt><dd>Double-click</dd></div>
              <div><dt>Up a level</dt><dd>Alt+↑</dd></div>
              <div><dt>Find a block</dt><dd>/</dd></div>
              <div><dt>Hide panels</dt><dd>{mod}+\</dd></div>
              {editing && (
                <>
                  <div><dt>Select several</dt><dd>Shift+click or drag a box</dd></div>
                  <div><dt>Select all</dt><dd>{mod}+A</dd></div>
                  <div><dt>Nudge</dt><dd>Arrows, Shift for 50</dd></div>
                  <div><dt>Ignore snapping</dt><dd>Hold {mod}</dd></div>
                  <div><dt>Connect</dt><dd>Drag from an edge dot</dd></div>
                  <div><dt>Add a block</dt><dd>B, or double-click</dd></div>
                  <div><dt>Delete · undo</dt><dd>Delete · {mod}+Z</dd></div>
                </>
              )}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
