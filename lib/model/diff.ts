import type { ArchitectureModel } from "./schema";
import type { ViewSnapshot } from "./view";

/**
 * What one version of the model changes relative to another, in the terms
 * people review: blocks and connections added, removed, or changed, field by
 * field. The canvas paints this; the change request page lists it.
 */

export type FieldChange = { field: string; before: unknown; after: unknown };

export type ChangeStatus = "added" | "removed" | "changed";

export type ModelDiff = {
  blocks: Array<{ id: string; name: string; status: ChangeStatus; fields: FieldChange[] }>;
  connections: Array<{ id: string; label: string; from: string; to: string; status: ChangeStatus; fields: FieldChange[] }>;
  /** Other sections that changed, such as layouts or behaviours. */
  sections: string[];
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function fieldChanges<T extends Record<string, unknown>>(before: T, after: T, ignore: string[] = []): FieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((field) => !ignore.includes(field));
  return fields.filter((field) => !same(before[field], after[field])).map((field) => ({ field, before: before[field], after: after[field] }));
}

function diffById<T extends { id: string }>(base: T[], head: T[]) {
  const before = new Map(base.map((item) => [item.id, item]));
  const after = new Map(head.map((item) => [item.id, item]));
  const out: Array<{ item: T; status: ChangeStatus; previous?: T }> = [];
  for (const item of head) {
    const previous = before.get(item.id);
    if (!previous) out.push({ item, status: "added" });
    else if (!same(previous, item)) out.push({ item, status: "changed", previous });
  }
  for (const item of base) if (!after.has(item.id)) out.push({ item, status: "removed" });
  return out;
}

/**
 * Where a block is drawn and what interfaces it has. Moving a block on the
 * canvas or sliding a port changes these, not the block's own record, but a
 * reviewer still needs to see that block as changed.
 */
function placement(model: ArchitectureModel, id: string, shared: string[]) {
  const position = Object.entries(model.layouts)
    .filter(([, layout]) => layout.nodes[id])
    .map(([canvas, layout]) => {
      const rect = layout.nodes[id];
      return `${canvas}: ${rect.x},${rect.y} ${rect.width}×${rect.height}`;
    });
  // Ports added or removed with a connection are that connection's change;
  // only a port that exists in both versions and moved is the block's.
  const ports = shared.map((port) => {
    const value = model.ports[id][port];
    return `${value.label} (${port}) ${value.side} ${value.offset}`;
  });
  return { position, interfaces: ports };
}

export function diffModels(base: ArchitectureModel, head: ArchitectureModel): ModelDiff {
  const sections = (["product", "owners", "protocols", "layouts", "ports", "behaviors", "instruction_flows"] as const).filter(
    (key) => !same(base[key], head[key]),
  );
  const baseIds = new Set(base.blocks.map((block) => block.id));
  const blocks = diffById(base.blocks, head.blocks).map(({ item, status, previous }) => ({
    id: item.id,
    name: item.name,
    status,
    fields: previous ? fieldChanges(previous, item, ["id"]) : [],
  }));
  const listed = new Set(blocks.map((block) => block.id));
  for (const block of head.blocks) {
    if (!baseIds.has(block.id)) continue;
    const shared = Object.keys(base.ports[block.id] ?? {}).filter((port) => head.ports[block.id]?.[port]);
    const moved = fieldChanges(placement(base, block.id, shared), placement(head, block.id, shared));
    if (!moved.length) continue;
    const entry = blocks.find((item) => item.id === block.id);
    if (entry) entry.fields.push(...moved);
    else if (!listed.has(block.id)) blocks.push({ id: block.id, name: block.name, status: "changed", fields: moved });
  }
  return {
    blocks,
    connections: diffById(base.connections, head.connections).map(({ item, status, previous }) => ({
      id: item.id,
      label: item.label,
      from: item.from,
      to: item.to,
      status,
      fields: previous ? fieldChanges(previous, item, ["id"]) : [],
    })),
    sections,
  };
}

export function diffIsEmpty(diff: ModelDiff) {
  return !diff.blocks.length && !diff.connections.length && !diff.sections.length;
}

export type SnapshotChanges = {
  /** The commit the changes are measured from. */
  baseSha: string;
  blocks: Record<string, ChangeStatus>;
  connections: Record<string, ChangeStatus>;
  fields: Record<string, FieldChange[]>;
  /** Blocks with a change somewhere inside them, so a closed composite still shows it. */
  within: string[];
  sections: string[];
};

/**
 * The head snapshot with what the base had and the head removed put back in,
 * marked as removed, so a reviewer sees a deletion where the block used to
 * be rather than as an absence.
 */
export function overlayChanges(head: ViewSnapshot, base: ViewSnapshot, diff: ModelDiff, baseSha: string): ViewSnapshot {
  const blocks = { ...head.blocks };
  const layouts = { ...head.layouts };
  const ports = { ...head.ports };
  const connections = [...head.connections];

  for (const change of diff.blocks.filter((item) => item.status === "removed")) {
    const removed = base.blocks[change.id];
    if (!removed) continue;
    blocks[change.id] = { ...removed, childIds: [] };
    if (removed.parent && blocks[removed.parent] && !blocks[removed.parent].childIds.includes(change.id)) {
      blocks[removed.parent] = { ...blocks[removed.parent], childIds: [...blocks[removed.parent].childIds, change.id] };
    }
    if (base.ports[change.id] && !ports[change.id]) ports[change.id] = base.ports[change.id];
    for (const [focusId, layout] of Object.entries(base.layouts)) {
      const rect = layout.nodes[change.id];
      if (!rect) continue;
      layouts[focusId] = layouts[focusId]
        ? { ...layouts[focusId], nodes: { ...layouts[focusId].nodes, [change.id]: rect } }
        : layout;
    }
  }
  for (const change of diff.connections.filter((item) => item.status === "removed")) {
    const removed = base.connections.find((item) => item.id === change.id);
    if (!removed) continue;
    connections.push(removed);
    for (const [blockId, portId] of [
      [removed.from, removed.fromPort],
      [removed.to, removed.toPort],
    ]) {
      const port = base.ports[blockId]?.find((item) => item.id === portId);
      if (port && !ports[blockId]?.some((item) => item.id === portId)) ports[blockId] = [...(ports[blockId] ?? []), port];
    }
  }

  const within = new Set<string>();
  for (const change of diff.blocks) {
    let cursor = blocks[change.id]?.parent ?? null;
    while (cursor && !within.has(cursor)) {
      within.add(cursor);
      cursor = blocks[cursor]?.parent ?? null;
    }
  }
  for (const change of diff.connections) {
    for (const id of [change.from, change.to]) {
      let cursor = blocks[id]?.parent ?? null;
      while (cursor && !within.has(cursor)) {
        within.add(cursor);
        cursor = blocks[cursor]?.parent ?? null;
      }
    }
  }

  return {
    ...head,
    blocks,
    layouts,
    ports,
    connections,
    changes: {
      baseSha,
      blocks: Object.fromEntries(diff.blocks.map((item) => [item.id, item.status])),
      connections: Object.fromEntries(diff.connections.map((item) => [item.id, item.status])),
      fields: Object.fromEntries(diff.blocks.filter((item) => item.fields.length).map((item) => [item.id, item.fields])),
      within: [...within],
      sections: diff.sections,
    },
  };
}
