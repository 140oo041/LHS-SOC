"use client";

import { useState } from "react";
import type { Side } from "@/lib/model/schema";
import type { ViewConnection, ViewSnapshot } from "@/lib/model/view";
import type { ModelSession } from "./model-session";

/**
 * The small forms that open on the canvas itself: what a block drawn by
 * double-clicking is called, and what a connection drawn by dragging
 * carries. Removals need no form: they happen at once and can be undone.
 */

export type CanvasPopover =
  | { kind: "add"; x: number; y: number }
  | { kind: "connect"; from: string; to: string; fromSide: Side; toSide: Side; x: number; y: number };

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function freeId(snapshot: ViewSnapshot, name: string) {
  const base = slugify(name) || "block";
  if (!snapshot.blocks[base]) return base;
  for (let n = 2; ; n += 1) if (!snapshot.blocks[`${base}-${n}`]) return `${base}-${n}`;
}

type Props = {
  popover: CanvasPopover;
  snapshot: ViewSnapshot;
  focusId: string;
  session: ModelSession;
  /** Where to draw it, in pixels inside the canvas frame. */
  position: { left: number; top: number };
  onClose(): void;
};

export function CanvasPopoverView({ popover, snapshot, focusId, session, position, onClose }: Props) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function send(...args: Parameters<ModelSession["submit"]>) {
    setPending(true);
    setError("");
    const result = await session.submit(...args);
    setPending(false);
    if (result.ok) onClose();
    else setError(result.error);
  }

  return (
    <div
      className="canvas-popover"
      style={{ left: position.left, top: position.top }}
      data-no-pan
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      {popover.kind === "add" && <AddBlock snapshot={snapshot} focusId={focusId} at={popover} pending={pending} send={send} onClose={onClose} />}
      {popover.kind === "connect" && <Connect snapshot={snapshot} popover={popover} pending={pending} send={send} onClose={onClose} />}
      {error && <p className="model-edit-error" role="alert">{error}</p>}
    </div>
  );
}

export function describe(snapshot: ViewSnapshot, connectionId: string, connection?: ViewConnection) {
  const item = connection ?? snapshot.connections.find((entry) => entry.id === connectionId);
  if (!item) return connectionId;
  return `${snapshot.blocks[item.from]?.name ?? item.from} ${item.bidirectional ? "↔" : "→"} ${snapshot.blocks[item.to]?.name ?? item.to} (${item.label})`;
}

type Send = (...args: Parameters<ModelSession["submit"]>) => Promise<void>;

function AddBlock({ snapshot, focusId, at, pending, send, onClose }: { snapshot: ViewSnapshot; focusId: string; at: { x: number; y: number }; pending: boolean; send: Send; onClose(): void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("module");
  const parent = snapshot.blocks[focusId];
  return (
    <form
      className="model-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        const id = freeId(snapshot, name);
        void send(
          {
            op: "addBlock",
            parent: focusId,
            id,
            name: name.trim(),
            kind: kind.trim(),
            owner: parent?.owner ?? "unassigned",
            maturity: "proposal",
            at: { x: Math.max(0, Math.round(at.x / 10) * 10), y: Math.max(0, Math.round(at.y / 10) * 10) },
          },
          id,
        );
      }}
    >
      <strong className="canvas-popover-title">New block in {parent?.name ?? focusId}</strong>
      <label>
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} autoFocus />
      </label>
      <label>
        <span>Kind</span>
        <input value={kind} onChange={(event) => setKind(event.target.value)} required maxLength={40} />
      </label>
      <div className="model-edit-actions">
        <button type="submit" className="model-edit-primary" disabled={pending}>{pending ? "Adding…" : "Add block"}</button>
        <button type="button" onClick={onClose} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}

let lastProtocol = "";

function Connect({ snapshot, popover, pending, send, onClose }: { snapshot: ViewSnapshot; popover: Extract<CanvasPopover, { kind: "connect" }>; pending: boolean; send: Send; onClose(): void }) {
  const protocols = Object.entries(snapshot.protocols).filter(([id]) => id !== "containment");
  const [protocol, setProtocol] = useState(protocols.some(([id]) => id === lastProtocol) ? lastProtocol : protocols[0]?.[0] ?? "");
  const [label, setLabel] = useState("");
  const [bidirectional, setBidirectional] = useState(false);
  const from = snapshot.blocks[popover.from];
  const to = snapshot.blocks[popover.to];
  return (
    <form
      className="model-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        lastProtocol = protocol;
        void send({
          op: "addConnection",
          from: popover.from,
          to: popover.to,
          fromSide: popover.fromSide,
          toSide: popover.toSide,
          protocol,
          label: label.trim(),
          bidirectional,
        });
      }}
    >
      <strong className="canvas-popover-title">
        {from?.name} → {to?.name}
      </strong>
      <label>
        <span>Protocol</span>
        <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
          {protocols.map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}
        </select>
      </label>
      <label>
        <span>Label</span>
        <input value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={80} placeholder="What travels on it" autoFocus />
      </label>
      <label className="canvas-popover-check">
        <input type="checkbox" checked={bidirectional} onChange={(event) => setBidirectional(event.target.checked)} /> Both ways
      </label>
      <div className="model-edit-actions">
        <button type="submit" className="model-edit-primary" disabled={pending}>{pending ? "Connecting…" : "Connect"}</button>
        <button type="button" onClick={onClose} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
