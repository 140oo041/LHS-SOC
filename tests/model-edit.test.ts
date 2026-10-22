import { readFileSync } from "node:fs";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { diffModels, overlayChanges } from "@/lib/model/diff";
import { applyModelEdit, facingSide, freeOffset, ModelEditError, placeNode, type ModelEdit } from "@/lib/model/edit";
import { parseModel } from "@/lib/model/load";
import { validateModel } from "@/lib/model/validate";
import { snapshotOf } from "@/lib/model/view";

const source = readFileSync(path.join(process.cwd(), "architecture/soc.yaml"), "utf8");
const model = parseModel(source);

/** Lines in `after` that are not in `before`, and the reverse: a rough diff size. */
function changedLines(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const added = b.filter((line) => !a.includes(line));
  const removed = a.filter((line) => !b.includes(line));
  return { added, removed };
}

function edit(text: string, change: ModelEdit) {
  return applyModelEdit(text, change);
}

const leaf = model.blocks.find((block) => block.parent && !model.blocks.some((child) => child.parent === block.id))!;

describe("model validation", () => {
  it("accepts the checked-in model", () => {
    expect(validateModel(parseYaml(source))).toMatchObject({ ok: true });
  });

  it("catches the cross-references the schema cannot", () => {
    const raw = parseYaml(source) as { connections: Array<{ to_port: string }>; blocks: Array<{ owner: string }> };
    raw.connections[0].to_port = "nowhere";
    raw.blocks[0].owner = "nobody";
    const result = validateModel(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.includes("unknown port"))).toBe(true);
      expect(result.issues.some((issue) => issue.includes("unknown owner"))).toBe(true);
    }
  });
});

describe("model edits", () => {
  it("changes only the edited lines, keeping the file's own formatting", () => {
    const { text, summary } = edit(source, { op: "updateBlock", id: leaf.id, fields: { summary: "A changed summary: with a colon." } });
    const { added, removed } = changedLines(source, text);
    expect(added).toEqual([`    summary: "A changed summary: with a colon."`]);
    expect(removed).toHaveLength(1);
    expect(summary).toContain(leaf.name);
    expect(parseModel(text).blocks.find((block) => block.id === leaf.id)?.summary).toBe("A changed summary: with a colon.");
  });

  it("refuses an edit that changes nothing", () => {
    expect(() => edit(source, { op: "updateBlock", id: leaf.id, fields: { name: leaf.name } })).toThrow(ModelEditError);
  });

  it("adds a block inside its parent, on free space of the parent's canvas", () => {
    const parent = leaf.parent!;
    const { text } = edit(source, {
      op: "addBlock",
      parent,
      id: "scratch-buffer",
      name: "Scratch buffer",
      kind: "memory",
      summary: "A small buffer for testing.",
      owner: "unassigned",
      maturity: "proposal",
      responsibilities: ["Hold scratch data."],
    });
    const next = parseModel(text);
    const added = next.blocks.find((block) => block.id === "scratch-buffer");
    expect(added?.parent).toBe(parent);
    const layout = next.layouts[parent];
    const rect = layout.nodes["scratch-buffer"];
    expect(rect).toBeDefined();
    for (const [id, other] of Object.entries(layout.nodes)) {
      if (id === "scratch-buffer") continue;
      const apart = rect.x + rect.width <= other.x || other.x + other.width <= rect.x || rect.y + rect.height <= other.y || other.y + other.height <= rect.y;
      expect(apart, `overlaps ${id}`).toBe(true);
    }
    // A block, plus one layout line (and possibly a grown canvas): nothing else.
    expect(changedLines(source, text).removed.length).toBeLessThanOrEqual(1);
  });

  it("gives a leaf its own canvas when it gains a child", () => {
    const { text } = edit(source, {
      op: "addBlock",
      parent: leaf.id,
      id: "inner-part",
      name: "Inner part",
      kind: "module",
      summary: "Something inside.",
      owner: "unassigned",
      maturity: "proposal",
      responsibilities: ["Exist."],
    });
    const next = parseModel(text);
    expect(next.layouts[leaf.id].nodes["inner-part"]).toBeDefined();
    expect(snapshotOf(next).blocks[leaf.id].sealed).toBe(false);
  });

  it("adds a block with only a name, to be described later", () => {
    const { text } = edit(source, { op: "addBlock", parent: leaf.id, id: "bare-part", name: "Bare part", kind: "module", owner: "unassigned", maturity: "proposal" });
    const added = parseModel(text).blocks.find((block) => block.id === "bare-part");
    expect(added?.summary).toBe("");
    expect(added?.responsibilities).toEqual([]);
  });

  it("refuses a duplicate ID and an unknown owner", () => {
    const base = { op: "addBlock" as const, parent: leaf.parent!, name: "X", kind: "k", summary: "s", owner: "unassigned", maturity: "proposal" as const, responsibilities: ["r"] };
    expect(() => edit(source, { ...base, id: leaf.id })).toThrow(/already exists/);
    expect(() => edit(source, { ...base, id: "fresh-id", owner: "nobody" })).toThrow(/invalid/);
  });

  it("connects two blocks on a shared canvas, adding ports that face each other", () => {
    const parent = leaf.parent!;
    const [a, b] = Object.keys(model.layouts[parent].nodes).filter((id) => model.blocks.find((block) => block.id === id)?.parent === parent);
    const { text } = edit(source, { op: "addConnection", from: a, to: b, protocol: "control", label: "test link", bidirectional: false });
    const next = parseModel(text);
    const connection = next.connections.at(-1)!;
    expect(connection).toMatchObject({ from: a, to: b, protocol: "control", label: "test link" });
    const fromPort = next.ports[a][connection.from_port];
    const toPort = next.ports[b][connection.to_port];
    const layout = next.layouts[parent];
    expect(fromPort.side).toBe(facingSide(layout.nodes[a], layout.nodes[b]));
    expect(toPort.side).toBe(facingSide(layout.nodes[b], layout.nodes[a]));
  });

  it("removes a connection and the ports only it used", () => {
    const added = edit(source, { op: "addConnection", from: "dma", to: "crossbar", protocol: "control", label: "probe", bidirectional: true }).text;
    const connection = parseModel(added).connections.at(-1)!;
    const removed = edit(added, { op: "removeConnection", id: connection.id }).text;
    expect(removed).toBe(source);
  });

  it("refuses a connection between blocks never drawn together", () => {
    const far = model.blocks.find((block) => !Object.values(model.layouts).some((layout) => layout.nodes[block.id] && layout.nodes["external-hyperram"]))!;
    expect(() => edit(source, { op: "addConnection", from: "external-hyperram", to: far.id, protocol: "control", label: "x", bidirectional: true })).toThrow(/same canvas/);
  });

  it("removes a block with its connections, ports, and layout entries", () => {
    const target = model.blocks.find(
      (block) =>
        block.id !== model.product.default_focus &&
        !model.blocks.some((child) => child.parent === block.id) &&
        model.connections.some((connection) => connection.from === block.id || connection.to === block.id) &&
        ![...model.instruction_flows, ...model.behaviors].some((flow) => flow.steps.some((step) => step.blocks.length === 1 && step.blocks[0] === block.id)),
    )!;
    const next = parseModel(edit(source, { op: "removeBlock", id: target.id }).text);
    expect(next.blocks.some((block) => block.id === target.id)).toBe(false);
    expect(next.connections.some((connection) => connection.from === target.id || connection.to === target.id)).toBe(false);
    expect(next.ports[target.id]).toBeUndefined();
    expect(Object.values(next.layouts).some((layout) => layout.nodes[target.id])).toBe(false);
  });

  it("refuses to remove a block that still contains others", () => {
    expect(() => edit(source, { op: "removeBlock", id: "coral-core" })).toThrow(/still contains/);
  });
});

describe("layout edits from the canvas", () => {
  it("moves and resizes a block on one canvas, changing one line", () => {
    const before = model.layouts["coral-soc"].nodes.uart;
    const { text, summary } = edit(source, { op: "moveNode", canvas: "coral-soc", id: "uart", x: before.x, y: before.y + 20, width: before.width - 40, height: before.height });
    expect(summary).toBe("Move and resize UART on the Coral SoC canvas");
    expect(parseModel(text).layouts["coral-soc"].nodes.uart).toEqual({ x: before.x, y: before.y + 20, width: before.width - 40, height: before.height });
    expect(changedLines(source, text).added).toHaveLength(1);
  });

  it("grows the canvas when a block is dragged past its edge", () => {
    const layout = model.layouts["coral-soc"];
    const { text } = edit(source, { op: "moveNode", canvas: "coral-soc", id: "uart", x: layout.canvas.width + 100, y: 10, width: 200, height: 100 });
    expect(parseModel(text).layouts["coral-soc"].canvas.width).toBe(layout.canvas.width + 100 + 200 + 40);
  });

  it("refuses to move a block on a canvas that does not draw it", () => {
    expect(() => edit(source, { op: "moveNode", canvas: "dma", id: "uart", x: 0, y: 0, width: 100, height: 100 })).toThrow(/not drawn/);
  });

  it("moves several blocks together in one edit", () => {
    const nodes = model.layouts["coral-soc"].nodes;
    const ids = Object.keys(nodes).slice(0, 3);
    const { text, summary } = edit(source, {
      op: "moveNodes",
      canvas: "coral-soc",
      nodes: ids.map((id) => ({ id, x: nodes[id].x + 30, y: nodes[id].y + 10, width: nodes[id].width, height: nodes[id].height })),
    });
    expect(summary).toBe("Move 3 blocks on the Coral SoC canvas");
    const next = parseModel(text).layouts["coral-soc"].nodes;
    for (const id of ids) expect(next[id]).toMatchObject({ x: nodes[id].x + 30, y: nodes[id].y + 10 });
    expect(changedLines(source, text).added.length).toBeLessThanOrEqual(6);
  });

  it("shifts the whole canvas when a block is dragged past the origin", () => {
    const layout = model.layouts["coral-soc"];
    const rect = layout.nodes.uart;
    const { text } = edit(source, { op: "moveNodes", canvas: "coral-soc", nodes: [{ id: "uart", x: -100, y: rect.y, width: rect.width, height: rect.height }] });
    const next = parseModel(text).layouts["coral-soc"];
    expect(next.nodes.uart.x).toBe(20);
    const other = Object.keys(layout.nodes).find((id) => id !== "uart")!;
    expect(next.nodes[other].x).toBe(layout.nodes[other].x + 120);
    expect(next.nodes[other].y).toBe(layout.nodes[other].y);
  });

  it("refuses a block moved further past the origin than the canvas allows", () => {
    const rect = model.layouts["coral-soc"].nodes.uart;
    expect(() => edit(source, { op: "moveNodes", canvas: "coral-soc", nodes: [{ id: "uart", x: -401, y: rect.y, width: rect.width, height: rect.height }] })).toThrow(ModelEditError);
  });

  it("refuses a batch move that names a block the canvas does not draw", () => {
    expect(() => edit(source, { op: "moveNodes", canvas: "dma", nodes: [{ id: "uart", x: 0, y: 0, width: 100, height: 100 }] })).toThrow(/not drawn/);
  });

  it("slides a port along an edge or onto another side", () => {
    const [portId] = Object.keys(model.ports.uart);
    const { text } = edit(source, { op: "movePort", block: "uart", port: portId, side: "bottom", offset: 0.333 });
    expect(parseModel(text).ports.uart[portId]).toMatchObject({ side: "bottom", offset: 0.33 });
  });

  it("puts a double-clicked block where it was asked for", () => {
    const { text } = edit(source, {
      op: "addBlock",
      parent: "coral-soc",
      id: "spi",
      name: "SPI",
      kind: "peripheral",
      summary: "Serial peripheral interface.",
      owner: "unassigned",
      maturity: "proposal",
      responsibilities: ["Talk SPI."],
      at: { x: 1770, y: 1100 },
    });
    expect(parseModel(text).layouts["coral-soc"].nodes.spi).toMatchObject({ x: 1770, y: 1100 });
  });

  it("puts a drawn connection's ports on the sides it was drawn from and to", () => {
    const { text } = edit(source, { op: "addConnection", from: "uart", to: "control", protocol: "control", label: "x", bidirectional: false, fromSide: "bottom", toSide: "top" });
    const next = parseModel(text);
    const connection = next.connections.at(-1)!;
    expect(next.ports.uart[connection.from_port].side).toBe("bottom");
    expect(next.ports.control[connection.to_port].side).toBe("top");
  });
});

describe("placement", () => {
  it("grows a full canvas instead of overlapping", () => {
    const full = { canvas: { width: 300, height: 200 }, nodes: { a: { x: 40, y: 40, width: 220, height: 120 } } };
    const { rect, canvas } = placeNode(full);
    expect(rect.x).toBeGreaterThanOrEqual(300);
    expect(canvas.width).toBeGreaterThan(300);
  });

  it("spreads ports along a side", () => {
    expect(freeOffset([])).toBe(0.5);
    expect(freeOffset([0.5])).toBe(0.25);
  });
});

describe("model diff", () => {
  it("reports added, removed, and changed blocks and connections", () => {
    let text = edit(source, { op: "updateBlock", id: leaf.id, fields: { maturity: "specified" } }).text;
    text = edit(text, { op: "addConnection", from: "dma", to: "crossbar", protocol: "control", label: "probe", bidirectional: true }).text;
    const head = parseModel(text);
    const diff = diffModels(model, head);
    expect(diff.blocks).toEqual([{ id: leaf.id, name: leaf.name, status: "changed", fields: [{ field: "maturity", before: leaf.maturity, after: "specified" }] }]);
    expect(diff.connections.map((item) => item.status)).toEqual(["added"]);
    expect(diff.sections).toContain("ports");
  });

  it("reports a block moved on the canvas as changed, with where it was", () => {
    const rect = model.layouts["coral-soc"].nodes.uart;
    const head = parseModel(edit(source, { op: "moveNode", canvas: "coral-soc", id: "uart", x: rect.x, y: rect.y + 10, width: rect.width, height: rect.height }).text);
    const [change] = diffModels(model, head).blocks;
    expect(change).toMatchObject({ id: "uart", status: "changed" });
    expect(change.fields.map((field) => field.field)).toEqual(["position"]);
  });

  it("puts removed blocks back on the canvas, marked as removed", () => {
    const target = "uart";
    const head = parseModel(edit(source, { op: "removeBlock", id: target }).text);
    const diff = diffModels(model, head);
    const overlay = overlayChanges(snapshotOf(head), snapshotOf(model), diff, "a".repeat(40));
    expect(overlay.blocks[target]).toBeDefined();
    expect(overlay.changes?.blocks[target]).toBe("removed");
    const parent = model.blocks.find((block) => block.id === target)!.parent!;
    expect(overlay.changes?.within).toContain(parent);
    expect(Object.values(overlay.layouts).some((layout) => layout.nodes[target])).toBe(true);
  });
});
