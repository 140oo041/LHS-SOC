"use client";

import { useState } from "react";
import type { ChangeStatus } from "@/lib/model/diff";
import type { ViewSnapshot } from "@/lib/model/view";

const STATUS_LABEL: Record<ChangeStatus, string> = { added: "Added", removed: "Removed", changed: "Changed" };

const SECTION_LABEL: Record<string, string> = {
  layouts: "layout",
  ports: "interfaces",
  behaviors: "behaviours",
  instruction_flows: "instruction paths",
  protocols: "protocols",
  owners: "owners",
  product: "product settings",
};

/**
 * What this branch changes in the model, above the canvas.
 *
 * The canvas paints each change where it is; this is the list of them, so a
 * change two levels down inside a composite is still one click away.
 */
export function ChangesPanel({
  snapshot,
  shown,
  onToggle,
  onSelect,
}: {
  snapshot: ViewSnapshot;
  shown: boolean;
  onToggle(): void;
  onSelect(blockId: string): void;
}) {
  const [open, setOpen] = useState(false);
  const changes = snapshot.changes!;
  const blocks = Object.entries(changes.blocks);
  const connections = Object.entries(changes.connections);
  // Interfaces and layout follow from block and connection edits; name them
  // only when nothing else explains them.
  const sections = changes.sections.filter((section) => !(["layouts", "ports"].includes(section) && (blocks.length || connections.length)));
  const count = blocks.length + connections.length + sections.length;

  if (!count) {
    return (
      <div className="changes-panel quiet">
        <p>No changes to the model on this branch yet.</p>
      </div>
    );
  }

  const tally = (["added", "changed", "removed"] as const)
    .map((status) => {
      const n = blocks.filter(([, value]) => value === status).length + connections.filter(([, value]) => value === status).length;
      return n ? `${n} ${status}` : null;
    })
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <p>
          <strong>This branch changes the model</strong>
          <span>{[tally, ...sections.map((section) => `${SECTION_LABEL[section] ?? section} edited`)].filter(Boolean).join(" · ")}</span>
        </p>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide list" : "List"}
        </button>
        <label className="changes-toggle">
          <input type="checkbox" checked={shown} onChange={onToggle} /> Mark on canvas
        </label>
      </div>
      {open && (
        <ul className="changes-list">
          {blocks.map(([id, status]) => (
            <li key={`block-${id}`}>
              <span className={`change-mark ${status}`}>{STATUS_LABEL[status]}</span>
              <button type="button" onClick={() => onSelect(id)}>
                {snapshot.blocks[id]?.name ?? id}
              </button>
              {changes.fields[id] && <small>{changes.fields[id].map((field) => field.field).join(", ")}</small>}
            </li>
          ))}
          {connections.map(([id, status]) => {
            const connection = snapshot.connections.find((item) => item.id === id);
            return (
              <li key={`connection-${id}`}>
                <span className={`change-mark ${status}`}>{STATUS_LABEL[status]}</span>
                {connection ? (
                  <button type="button" onClick={() => onSelect(connection.from)}>
                    {snapshot.blocks[connection.from]?.name ?? connection.from} → {snapshot.blocks[connection.to]?.name ?? connection.to}
                  </button>
                ) : (
                  <span>{id}</span>
                )}
                <small>connection{connection ? ` · ${connection.label}` : ""}</small>
              </li>
            );
          })}
          {sections.map((section) => (
            <li key={`section-${section}`}>
              <span className="change-mark changed">Changed</span>
              <span>{SECTION_LABEL[section] ?? section}</span>
              <small>see the YAML diff in the change request</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
