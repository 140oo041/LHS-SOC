import { isMap, isScalar, isSeq, parseDocument, YAMLMap, type Document, type YAMLSeq } from "yaml";
import { z } from "zod";
import { ModelInvalidError, parseModel } from "./load";
import { MIN_COORDINATE, originShift } from "./origin";
import { MATURITY, SIDES, type ArchitectureModel, type Layout, type Rect, type Side } from "./schema";

/**
 * Structured edits to the architecture model.
 *
 * People change the model through forms, never by typing YAML, and each form
 * becomes one of these operations. They are applied to the parsed YAML
 * document rather than to a re-serialised object, so a commit changes only
 * the lines the edit is about: a reviewer reads a two-line diff, not a
 * reformatted 1,800-line file.
 *
 * The canvas edits the layout directly: blocks are dragged and resized,
 * ports slid along their edges, and connections drawn from one block to
 * another. Anything not placed by hand is placed automatically: a new block
 * from a form goes into the first free space on its parent's canvas, and a
 * new connection gets ports on the sides that face each other. The result is
 * validated in full before it is returned, so an edit that would break the
 * model never reaches a branch.
 */

export const BLOCK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

const line = (max: number) => z.string().trim().min(1).max(max);

const coordinate = z.number().min(0).max(20000);
const side = z.enum(SIDES);

const blockFields = z.object({
  name: line(80),
  kind: line(40),
  /** May be empty: a block can be drawn first and described later. */
  summary: z.string().trim().max(600),
  owner: line(80),
  maturity: z.enum(MATURITY),
  responsibilities: z.array(line(300)).max(30),
});

export const EDITABLE_BLOCK_FIELDS = Object.keys(blockFields.shape) as Array<keyof z.infer<typeof blockFields>>;

export const modelEditSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("updateBlock"), id: z.string(), fields: blockFields.partial() }),
  z.object({
    op: z.literal("addBlock"),
    parent: z.string(),
    id: z.string().regex(BLOCK_ID, "IDs use lowercase letters, numbers, and hyphens"),
    ...blockFields.shape,
    summary: blockFields.shape.summary.default(""),
    responsibilities: blockFields.shape.responsibilities.default([]),
    /** Where to put it on the parent's canvas; free space is found when omitted. */
    at: z.object({ x: coordinate, y: coordinate }).optional(),
  }),
  z.object({ op: z.literal("removeBlock"), id: z.string() }),
  z.object({
    op: z.literal("addConnection"),
    from: z.string(),
    to: z.string(),
    protocol: z.string(),
    label: line(80),
    bidirectional: z.boolean(),
    /** An existing port to use; a new one is added when omitted. */
    fromPort: z.string().optional(),
    toPort: z.string().optional(),
    /** Which side a new port goes on; the side facing the other block when omitted. */
    fromSide: side.optional(),
    toSide: side.optional(),
  }),
  z.object({ op: z.literal("updateConnection"), id: z.string(), label: line(80).optional(), bidirectional: z.boolean().optional() }),
  z.object({ op: z.literal("removeConnection"), id: z.string() }),
  z.object({
    op: z.literal("moveNode"),
    /** The canvas the block was moved on: a block can be drawn on several. */
    canvas: z.string(),
    id: z.string(),
    x: coordinate,
    y: coordinate,
    width: z.number().min(40).max(20000),
    height: z.number().min(30).max(20000),
  }),
  z.object({
    op: z.literal("moveNodes"),
    canvas: z.string(),
    /**
     * Several blocks moved or resized together, as one commit. Positions may
     * be negative: the canvas is then shifted so its top-left block is back
     * at the origin, which is how a block dragged above or left of everything
     * else is stored.
     */
    nodes: z
      .array(
        z.object({
          id: z.string(),
          x: z.number().min(MIN_COORDINATE).max(20000),
          y: z.number().min(MIN_COORDINATE).max(20000),
          width: z.number().min(40).max(20000),
          height: z.number().min(30).max(20000),
        }),
      )
      .min(1)
      .max(200),
  }),
  z.object({ op: z.literal("movePort"), block: z.string(), port: z.string(), side, offset: z.number().min(0).max(1) }),
]);

/** An edit as sent; the schema fills in what a new block may leave out. */
export type ModelEdit = z.input<typeof modelEditSchema>;
type Edit = z.output<typeof modelEditSchema>;

export class ModelEditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

const STRINGIFY = { lineWidth: 0, flowCollectionPadding: false } as const;

/** Applies one edit to the model's text. Throws ModelEditError when it cannot. */
export function applyModelEdit(text: string, input: ModelEdit): { text: string; summary: string } {
  const parsed = modelEditSchema.safeParse(input);
  if (!parsed.success) throw new ModelEditError(parsed.error.issues[0]?.message ?? "That edit is not valid", 400);
  const edit = parsed.data;
  const model = parseModel(text);
  const doc = parseDocument(text);
  const summary = apply(doc, model, edit);
  const next = doc.toString(STRINGIFY);
  try {
    parseModel(next);
  } catch (error) {
    if (error instanceof ModelInvalidError) {
      throw new ModelEditError(`That edit would leave the model invalid: ${error.issues.slice(0, 3).join("; ")}`, 400);
    }
    throw error;
  }
  return { text: next, summary };
}

function apply(doc: Document, model: ArchitectureModel, edit: Edit): string {
  switch (edit.op) {
    case "updateBlock":
      return updateBlock(doc, model, edit);
    case "addBlock":
      return addBlock(doc, model, edit);
    case "removeBlock":
      return removeBlock(doc, model, edit.id);
    case "addConnection":
      return addConnection(doc, model, edit);
    case "updateConnection":
      return updateConnection(doc, model, edit);
    case "removeConnection":
      return removeConnection(doc, model, edit.id);
    case "moveNode":
      return moveNode(doc, model, edit);
    case "moveNodes":
      return moveNodes(doc, model, edit);
    case "movePort":
      return movePort(doc, model, edit);
  }
}

// ---------------------------------------------------------------------------
// Document helpers

function section<T extends YAMLMap | YAMLSeq>(doc: Document, key: string): T {
  const node = doc.get(key, true);
  if (!isMap(node) && !isSeq(node)) throw new ModelEditError(`The model has no ${key} section`, 400);
  return node as T;
}

/** A nested mapping, or undefined when the key is absent. */
function childMap(parent: YAMLMap, key: string): YAMLMap | undefined {
  const node = parent.get(key, true);
  return isMap(node) ? node : undefined;
}

function itemIndex(seq: YAMLSeq, id: string) {
  return seq.items.findIndex((item) => isMap(item) && item.get("id") === id);
}

/** Changes a value in place where possible, so its quoting style survives. */
function setValue(doc: Document, map: YAMLMap, key: string, value: unknown) {
  const node = map.get(key, true);
  if (isScalar(node) && (value === null || typeof value !== "object")) node.value = value;
  else map.set(key, doc.createNode(value));
}

function flowNode(doc: Document, value: object) {
  const node = doc.createNode(value);
  node.flow = true;
  return node;
}

function blockOf(model: ArchitectureModel, id: string) {
  const block = model.blocks.find((item) => item.id === id);
  if (!block) throw new ModelEditError(`There is no block '${id}'`, 404);
  return block;
}

// ---------------------------------------------------------------------------
// Blocks

function updateBlock(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "updateBlock" }>) {
  const block = blockOf(model, edit.id);
  const blocks = section<YAMLSeq>(doc, "blocks");
  const node = blocks.items[itemIndex(blocks, edit.id)] as YAMLMap;
  const changed: string[] = [];
  for (const field of EDITABLE_BLOCK_FIELDS) {
    const value = edit.fields[field];
    if (value === undefined || JSON.stringify(value) === JSON.stringify(block[field])) continue;
    setValue(doc, node, field, value);
    changed.push(field);
  }
  if (!changed.length) throw new ModelEditError("Nothing changed", 400);
  return `Update ${block.name}: ${changed.join(", ")}`;
}

function descendantsOf(model: ArchitectureModel, id: string) {
  const found = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const block of model.blocks) {
      if (block.parent && found.has(block.parent) && !found.has(block.id)) {
        found.add(block.id);
        grew = true;
      }
    }
  }
  return found;
}

function addBlock(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "addBlock" }>) {
  const parent = blockOf(model, edit.parent);
  if (model.blocks.some((block) => block.id === edit.id)) throw new ModelEditError(`A block called '${edit.id}' already exists`, 409);

  const siblings = model.blocks.filter((block) => block.parent === parent.id);
  const rank = siblings.length ? Math.max(...siblings.map((block) => block.rank)) : 0;
  const order = siblings.filter((block) => block.rank === rank).reduce((next, block) => Math.max(next, block.order + 1), 0);
  const node = doc.createNode({
    id: edit.id,
    name: edit.name,
    kind: edit.kind,
    summary: edit.summary,
    parent: parent.id,
    owner: edit.owner,
    maturity: edit.maturity,
    rank,
    order,
    responsibilities: edit.responsibilities,
    documents: [],
    issues: [],
    rtl: [],
  });
  node.spaceBefore = true;

  // Next to its family in the file, so the YAML still reads top-down.
  const family = descendantsOf(model, parent.id);
  const blocks = section<YAMLSeq>(doc, "blocks");
  const last = model.blocks.reduce((at, block, index) => (family.has(block.id) ? index : at), -1);
  blocks.items.splice(last + 1, 0, node);

  const layouts = section<YAMLMap>(doc, "layouts");
  const existing = model.layouts[parent.id];
  if (existing) {
    const { rect, canvas } = edit.at ? placeAt(existing, edit.at) : placeNode(existing);
    const layout = childMap(layouts, parent.id)!;
    childMap(layout, "nodes")!.set(edit.id, flowNode(doc, rect));
    if (canvas.width !== existing.canvas.width || canvas.height !== existing.canvas.height) {
      layout.set("canvas", flowNode(doc, canvas));
    }
  } else {
    // The parent was a leaf; now it is a composite and needs a canvas of its own.
    const empty = { canvas: { width: 1, height: 1 }, nodes: {} };
    const { rect, canvas } = edit.at ? placeAt(empty, edit.at) : placeNode(empty);
    const nodes = new YAMLMap();
    nodes.set(edit.id, flowNode(doc, rect));
    const layout = new YAMLMap();
    layout.set("canvas", flowNode(doc, canvas));
    layout.set("nodes", nodes);
    layouts.set(parent.id, layout);
  }
  return `Add ${edit.name} to ${parent.name}`;
}

function removeBlock(doc: Document, model: ArchitectureModel, id: string) {
  const block = blockOf(model, id);
  if (model.product.default_focus === id) throw new ModelEditError(`${block.name} is the canvas Atlas opens on, so it cannot be removed`, 409);
  const children = model.blocks.filter((item) => item.parent === id);
  if (children.length) {
    throw new ModelEditError(`${block.name} still contains ${children.length} block(s). Remove those first.`, 409);
  }
  for (const [key, label] of [
    ["instruction_flows", "instruction path"],
    ["behaviors", "behaviour"],
  ] as const) {
    for (const flow of model[key]) {
      const sole = flow.steps.find((step) => step.blocks.length === 1 && step.blocks[0] === id);
      if (sole) throw new ModelEditError(`The ${label} "${flow.name}" has a step ("${sole.title}") involving only ${block.name}. Change that step first.`, 409);
    }
  }

  for (const key of ["instruction_flows", "behaviors"] as const) {
    model[key].forEach((flow, flowIndex) => {
      flow.steps.forEach((step, stepIndex) => {
        if (!step.blocks.includes(id)) return;
        const list = doc.getIn([key, flowIndex, "steps", stepIndex, "blocks"], true) as YAMLSeq;
        list.items = list.items.filter((item) => !(isScalar(item) ? item.value === id : item === id));
      });
    });
  }

  for (const connection of model.connections.filter((item) => item.from === id || item.to === id)) {
    removeConnection(doc, model, connection.id);
    model = { ...model, connections: model.connections.filter((item) => item.id !== connection.id) };
  }
  const ports = section<YAMLMap>(doc, "ports");
  if (ports.has(id)) ports.delete(id);

  const layouts = section<YAMLMap>(doc, "layouts");
  for (const [focusId, layout] of Object.entries(model.layouts)) {
    if (layout.nodes[id]) childMap(childMap(layouts, focusId)!, "nodes")!.delete(id);
  }
  if (layouts.has(id)) layouts.delete(id);

  const blocks = section<YAMLSeq>(doc, "blocks");
  blocks.items.splice(itemIndex(blocks, id), 1);
  return `Remove ${block.name}`;
}

const GAP = 40;
const STEP = 20;

function overlaps(a: Rect, b: Rect, gap: number) {
  return !(a.x + a.width + gap <= b.x || b.x + b.width + gap <= a.x || a.y + a.height + gap <= b.y || b.y + b.height + gap <= a.y);
}

function median(values: number[], fallback: number) {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Where a new block goes on a canvas: the first free space, reading
 * top-left to bottom-right, at the size its neighbours typically are. With no
 * room, the canvas grows: sideways while it is tall, downwards once it is
 * wide, so it keeps a screen-like shape.
 */
function typicalSize(layout: Pick<Layout, "nodes">) {
  const rects = Object.values(layout.nodes);
  return {
    width: Math.min(320, Math.max(160, Math.round(median(rects.map((rect) => rect.width), 240) / 10) * 10)),
    height: Math.min(160, Math.max(90, Math.round(median(rects.map((rect) => rect.height), 120) / 10) * 10)),
  };
}

/** The canvas grown, if need be, to hold a rect with a margin around it. */
function grownCanvas(canvas: Layout["canvas"], rect: Rect): Layout["canvas"] {
  return { width: Math.max(canvas.width, rect.x + rect.width + GAP), height: Math.max(canvas.height, rect.y + rect.height + GAP) };
}

/** A new block of the usual size with its top-left corner where it was put. */
export function placeAt(layout: Pick<Layout, "canvas" | "nodes">, at: { x: number; y: number }) {
  const rect = { x: Math.round(at.x), y: Math.round(at.y), ...typicalSize(layout) };
  return { rect, canvas: grownCanvas(layout.canvas, rect) };
}

export function placeNode(layout: Pick<Layout, "canvas" | "nodes">): { rect: Rect; canvas: Layout["canvas"] } {
  const rects = Object.values(layout.nodes);
  const { width, height } = typicalSize(layout);
  const canvas = { ...layout.canvas };

  for (let y = GAP; y + height + GAP <= canvas.height; y += STEP) {
    for (let x = GAP; x + width + GAP <= canvas.width; x += STEP) {
      const rect = { x, y, width, height };
      if (!rects.some((other) => overlaps(rect, other, GAP / 2))) return { rect, canvas };
    }
  }

  const right = rects.reduce((edge, rect) => Math.max(edge, rect.x + rect.width), 0);
  const bottom = rects.reduce((edge, rect) => Math.max(edge, rect.y + rect.height), 0);
  const rect =
    !rects.length || canvas.width <= canvas.height * 1.6
      ? { x: rects.length ? right + GAP : GAP, y: GAP, width, height }
      : { x: GAP, y: bottom + GAP, width, height };
  canvas.width = Math.max(canvas.width, rect.x + width + GAP);
  canvas.height = Math.max(canvas.height, rect.y + height + GAP);
  return { rect, canvas };
}

// ---------------------------------------------------------------------------
// Connections

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "link";
}

function unique(base: string, taken: (id: string) => boolean) {
  if (!taken(base)) return base;
  for (let n = 2; ; n += 1) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** The side of `from` that faces `to` on a canvas showing both. */
export function facingSide(from: Rect, to: Rect): Side {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/** A spot on a side that is as far as possible from the ports already there. */
export function freeOffset(taken: number[]) {
  const candidates = [0.5, 0.25, 0.75, 0.15, 0.35, 0.65, 0.85, 0.1, 0.9];
  let best = 0.5;
  let bestDistance = -1;
  for (const offset of candidates) {
    const distance = Math.min(1, ...taken.map((other) => Math.abs(other - offset)));
    if (distance >= 0.1) return offset;
    if (distance > bestDistance) [best, bestDistance] = [offset, distance];
  }
  return best;
}

/** The canvases on which both blocks are drawn, the endpoint's own parent's first. */
export function sharedCanvases(model: ArchitectureModel, a: string, b: string) {
  const parent = model.blocks.find((block) => block.id === a)?.parent;
  return Object.entries(model.layouts)
    .filter(([, layout]) => layout.nodes[a] && layout.nodes[b])
    .sort(([x], [y]) => Number(y === parent) - Number(x === parent))
    .map(([id]) => id);
}

function addConnection(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "addConnection" }>) {
  const from = blockOf(model, edit.from);
  const to = blockOf(model, edit.to);
  if (from.id === to.id) throw new ModelEditError("A connection needs two different blocks", 400);
  const protocol = model.protocols[edit.protocol];
  if (!protocol || edit.protocol === "containment") throw new ModelEditError(`'${edit.protocol}' is not a connection protocol`, 400);
  const canvasId = sharedCanvases(model, from.id, to.id)[0];
  if (!canvasId) {
    throw new ModelEditError(`${from.name} and ${to.name} are never drawn on the same canvas, so a connection between them could not be shown`, 400);
  }
  const layout = model.layouts[canvasId];

  const ports = section<YAMLMap>(doc, "ports");
  const portFor = (block: typeof from, peer: typeof to, chosen: string | undefined) => {
    const existing = model.ports[block.id] ?? {};
    if (chosen) {
      const port = existing[chosen];
      if (!port) throw new ModelEditError(`${block.name} has no port '${chosen}'`, 404);
      if (port.protocol !== edit.protocol) throw new ModelEditError(`${block.name}'s port '${chosen}' is ${port.protocol}, not ${edit.protocol}`, 400);
      return chosen;
    }
    const side = (block.id === from.id ? edit.fromSide : edit.toSide) ?? facingSide(layout.nodes[block.id], layout.nodes[peer.id]);
    const id = unique(slug(peer.id), (candidate) => Boolean(existing[candidate]));
    const port = {
      label: protocol.abbreviation,
      protocol: edit.protocol,
      side,
      offset: freeOffset(Object.values(existing).filter((other) => other.side === side).map((other) => other.offset)),
    };
    let map = childMap(ports, block.id);
    if (!map) {
      map = new YAMLMap();
      ports.set(block.id, map);
    }
    map.set(id, flowNode(doc, port));
    model = { ...model, ports: { ...model.ports, [block.id]: { ...existing, [id]: port } } };
    return id;
  };

  const fromPort = portFor(from, to, edit.fromPort);
  const toPort = portFor(to, from, edit.toPort);
  const id = unique(slug(`${from.id}-${to.id}`), (candidate) => model.connections.some((item) => item.id === candidate));
  section<YAMLSeq>(doc, "connections").items.push(
    flowNode(doc, {
      id,
      from: from.id,
      from_port: fromPort,
      to: to.id,
      to_port: toPort,
      protocol: edit.protocol,
      label: edit.label,
      bidirectional: edit.bidirectional,
    }),
  );
  return `Connect ${from.name} to ${to.name} (${protocol.abbreviation})`;
}

function connectionOf(model: ArchitectureModel, id: string) {
  const connection = model.connections.find((item) => item.id === id);
  if (!connection) throw new ModelEditError(`There is no connection '${id}'`, 404);
  return connection;
}

function updateConnection(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "updateConnection" }>) {
  const connection = connectionOf(model, edit.id);
  const connections = section<YAMLSeq>(doc, "connections");
  const node = connections.items[itemIndex(connections, edit.id)] as YAMLMap;
  const changed: string[] = [];
  if (edit.label !== undefined && edit.label !== connection.label) {
    setValue(doc, node, "label", edit.label);
    changed.push("label");
  }
  if (edit.bidirectional !== undefined && edit.bidirectional !== connection.bidirectional) {
    setValue(doc, node, "bidirectional", edit.bidirectional);
    changed.push("direction");
  }
  if (!changed.length) throw new ModelEditError("Nothing changed", 400);
  return `Update connection ${connection.id}: ${changed.join(", ")}`;
}

/**
 * Removes a connection, and any port that only it used: a port nothing
 * connects to would stay on the canvas as an unexplained mark.
 */
function removeConnection(doc: Document, model: ArchitectureModel, id: string) {
  const connection = connectionOf(model, id);
  const connections = section<YAMLSeq>(doc, "connections");
  connections.items.splice(itemIndex(connections, id), 1);
  const rest = model.connections.filter((item) => item.id !== id);
  const ports = section<YAMLMap>(doc, "ports");
  for (const [blockId, portId] of [
    [connection.from, connection.from_port],
    [connection.to, connection.to_port],
  ]) {
    const used = rest.some((item) => (item.from === blockId && item.from_port === portId) || (item.to === blockId && item.to_port === portId));
    const map = childMap(ports, blockId);
    if (used || !map?.has(portId)) continue;
    map.delete(portId);
    if (!map.items.length) ports.delete(blockId);
  }
  const from = model.blocks.find((block) => block.id === connection.from)?.name ?? connection.from;
  const to = model.blocks.find((block) => block.id === connection.to)?.name ?? connection.to;
  return `Disconnect ${from} from ${to}`;
}

// ---------------------------------------------------------------------------
// Layout, edited on the canvas

function moveNode(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "moveNode" }>) {
  const block = blockOf(model, edit.id);
  const layout = model.layouts[edit.canvas];
  const before = layout?.nodes[edit.id];
  if (!layout || !before) throw new ModelEditError(`${block.name} is not drawn on that canvas`, 404);
  const rect = { x: Math.round(edit.x), y: Math.round(edit.y), width: Math.round(edit.width), height: Math.round(edit.height) };
  const moved = rect.x !== before.x || rect.y !== before.y;
  const resized = rect.width !== before.width || rect.height !== before.height;
  if (!moved && !resized) throw new ModelEditError("Nothing changed", 400);

  const layoutNode = childMap(section<YAMLMap>(doc, "layouts"), edit.canvas)!;
  const node = childMap(childMap(layoutNode, "nodes")!, edit.id)!;
  for (const key of ["x", "y", "width", "height"] as const) setValue(doc, node, key, rect[key]);
  const canvas = grownCanvas(layout.canvas, rect);
  if (canvas.width !== layout.canvas.width || canvas.height !== layout.canvas.height) {
    const canvasNode = childMap(layoutNode, "canvas")!;
    setValue(doc, canvasNode, "width", canvas.width);
    setValue(doc, canvasNode, "height", canvas.height);
  }
  const where = blockOf(model, edit.canvas).name;
  return `${moved && resized ? "Move and resize" : moved ? "Move" : "Resize"} ${block.name} on the ${where} canvas`;
}

function moveNodes(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "moveNodes" }>) {
  const layout = model.layouts[edit.canvas];
  if (!layout) throw new ModelEditError("There is no such canvas", 404);
  const rects: Record<string, Rect> = { ...layout.nodes };
  const moved = new Set<string>();
  for (const item of edit.nodes) {
    const block = blockOf(model, item.id);
    const before = layout.nodes[item.id];
    if (!before) throw new ModelEditError(`${block.name} is not drawn on that canvas`, 404);
    const rect = { x: Math.round(item.x), y: Math.round(item.y), width: Math.round(item.width), height: Math.round(item.height) };
    if (rect.x === before.x && rect.y === before.y && rect.width === before.width && rect.height === before.height) continue;
    rects[item.id] = rect;
    moved.add(item.id);
  }
  if (!moved.size) throw new ModelEditError("Nothing changed", 400);

  // Anything pushed past the origin shifts the whole canvas back into place.
  const shift = originShift(Object.values(rects));

  const layoutNode = childMap(section<YAMLMap>(doc, "layouts"), edit.canvas)!;
  const nodesNode = childMap(layoutNode, "nodes")!;
  let canvas = layout.canvas;
  for (const [id, rect] of Object.entries(rects)) {
    const next = { ...rect, x: rect.x + shift.x, y: rect.y + shift.y };
    const before = layout.nodes[id];
    canvas = grownCanvas(canvas, next);
    if (next.x === before.x && next.y === before.y && next.width === before.width && next.height === before.height) continue;
    const node = childMap(nodesNode, id)!;
    for (const key of ["x", "y", "width", "height"] as const) setValue(doc, node, key, next[key]);
  }
  if (canvas.width !== layout.canvas.width || canvas.height !== layout.canvas.height) {
    const canvasNode = childMap(layoutNode, "canvas")!;
    setValue(doc, canvasNode, "width", canvas.width);
    setValue(doc, canvasNode, "height", canvas.height);
  }
  const where = blockOf(model, edit.canvas).name;
  if (moved.size === 1) {
    const [id] = moved;
    return `Move ${blockOf(model, id).name} on the ${where} canvas`;
  }
  return `Move ${moved.size} blocks on the ${where} canvas`;
}

function movePort(doc: Document, model: ArchitectureModel, edit: Extract<Edit, { op: "movePort" }>) {
  const block = blockOf(model, edit.block);
  const port = model.ports[edit.block]?.[edit.port];
  if (!port) throw new ModelEditError(`${block.name} has no port '${edit.port}'`, 404);
  const offset = Math.round(Math.min(0.95, Math.max(0.05, edit.offset)) * 100) / 100;
  if (port.side === edit.side && port.offset === offset) throw new ModelEditError("Nothing changed", 400);
  const node = childMap(childMap(section<YAMLMap>(doc, "ports"), edit.block)!, edit.port)!;
  setValue(doc, node, "side", edit.side);
  setValue(doc, node, "offset", offset);
  return `Move port ${port.label} on ${block.name}`;
}
