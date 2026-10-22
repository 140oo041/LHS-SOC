import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/domain";
import { layoutGraph } from "@/lib/content/commit-graph";
import type { GraphCommit } from "@/lib/content/types";

vi.mock("@/auth", () => ({ auth: async () => null }));

const { contentStore, readCommits, resetMemoryContent } = await import("@/lib/content");
const { createMemoryRepository } = await import("@/lib/content/memory-store");
const { modelAt, publishedModel } = await import("@/lib/model/at");
const { editModel } = await import("@/lib/model-edits");
const { rollBack, rollbackChanges } = await import("@/lib/rollback");
const edits = await import("@/lib/wiki-edits");
const changes = await import("@/lib/change-requests/service");
const { getWikiPage } = await import("@/lib/wiki");

const author: Actor = { email: "rtl@example.com", name: "Riley RTL", role: "editor" };
const reviewer: Actor = { email: "arch@example.com", name: "Arch", role: "editor" };
const admin: Actor = { email: "lead@example.com", name: "Lead", role: "admin" };
const viewer: Actor = { email: "guest@example.com", name: "Guest", role: "viewer" };

const MODEL = readFileSync(path.join(process.cwd(), "architecture/soc.yaml"), "utf8");

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GITHUB_APP_ID;
  process.env.ATLAS_ADMIN_EMAILS = admin.email;
  process.env.ATLAS_EDITOR_EMAILS = `${author.email},${reviewer.email}`;
  resetMemoryContent(
    createMemoryRepository("main", { "architecture/soc.yaml": MODEL, "docs/dma.md": "# DMA\n\nMoves data.\n", "src/app.ts": "export {};\n" }),
  );
  globalThis.__atlasChangeRequests = undefined;
  globalThis.__atlasMembers = new Map();
  globalThis.__atlasAudit = [];
});

const commit = (sha: string, parents: string[], minute: number): GraphCommit => ({
  sha,
  parents,
  message: sha,
  authorName: "x",
  date: `2026-10-18T10:${String(minute).padStart(2, "0")}:00Z`,
});

describe("the commit graph", () => {
  it("draws a branch beside the line it forked from, joining at the fork", () => {
    // main: a - b - c ; branch: b - x - y
    const graph = layoutGraph([commit("a", [], 0), commit("b", ["a"], 1), commit("c", ["b"], 2), commit("x", ["b"], 3), commit("y", ["x"], 4)]);
    expect(graph.rows.map((row) => row.commit.sha)).toEqual(["y", "x", "c", "b", "a"]);
    const lane = Object.fromEntries(graph.rows.map((row) => [row.commit.sha, row.lane]));
    expect(lane.y).toBe(lane.x);
    expect(lane.c).not.toBe(lane.x);
    expect(lane.b).toBe(lane.a);
    expect(graph.laneCount).toBe(2);
    // Both lines end at b.
    const intoB = graph.edges.filter((edge) => edge.toRow === 3);
    expect(intoB).toHaveLength(2);
  });

  it("gives a merge's second parent a lane of its own", () => {
    const graph = layoutGraph([commit("a", [], 0), commit("f", ["a"], 1), commit("m", ["a", "f"], 2)]);
    const lanes = new Set(graph.rows.map((row) => row.lane));
    expect(lanes.size).toBe(2);
    expect(graph.edges.filter((edge) => edge.fromRow === 0)).toHaveLength(2);
  });

  it("marks a parent older than the history shown", () => {
    const graph = layoutGraph([commit("b", ["a"], 1)]);
    expect(graph.edges).toEqual([{ fromLane: 0, viaLane: 0, toLane: 0, fromRow: 0, toRow: null }]);
  });
});

async function mergedChange() {
  const branch = await edits.createBranch(author, "uart spec");
  const model = (await modelAt({ branch }))!;
  await editModel(author, { branch, expectedBlobSha: model.blobSha, edit: { op: "updateBlock", id: "uart", fields: { maturity: "specified" } } });
  const page = (await getWikiPage("dma", { branch }))!;
  await edits.savePage(author, { branch, slug: "dma", source: `${page.source}UART specified.\n`, expectedBlobSha: page.blobSha, message: "Note" });
  await edits.savePage(author, { branch, slug: "new-page", source: "# New\n", expectedBlobSha: null, message: "Add page" });
  const request = await changes.openChangeRequest(author, { branch, title: "Specify UART", description: "" });
  await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
  return changes.mergeChangeRequest(admin, request.number);
}

describe("rolling back", () => {
  it("lists every commit on every branch with its parents", async () => {
    const store = await contentStore();
    const before = (await store.resolveHead("main"))!;
    await mergedChange();
    const branch = await edits.createBranch(author, "later");
    const heads = (await store.listBranches()).map((item) => item.headSha);
    const commits = await readCommits(heads, 50);
    expect(commits.some((item) => item.sha === before)).toBe(true);
    expect(commits.every((item) => Array.isArray(item.parents))).toBe(true);
    expect(branch).toBe("atlas/later");
  });

  it("rolls the published version back through a new branch, leaving code alone", async () => {
    const store = await contentStore();
    const original = (await store.resolveHead("main"))!;
    await mergedChange();
    const mergedHead = (await store.resolveHead("main"))!;

    const result = await rollBack(author, { sha: original });
    expect(result.created).toBe(true);
    expect(result.branch).toMatch(/^atlas\/rollback-/);
    // main itself is untouched until the rollback is approved.
    expect(await store.resolveHead("main")).toBe(mergedHead);

    const onBranch = { branch: result.branch };
    expect((await modelAt(onBranch))!.model.blocks.find((block) => block.id === "uart")?.maturity).toBe("proposal");
    expect((await getWikiPage("dma", onBranch))!.content).not.toContain("UART specified.");
    expect(await getWikiPage("new-page", onBranch)).toBeNull();
    // Content outside the wiki and model is never part of a rollback.
    expect((await rollbackChanges(original, (await store.resolveHead(result.branch))!)).length).toBe(0);
    const files = await store.listFiles((await store.resolveHead(result.branch))!, "src");
    expect(files.map((file) => file.path)).toEqual(["src/app.ts"]);

    // Approved and merged like any change.
    const request = await changes.openChangeRequest(author, { branch: result.branch, title: result.title, description: "" });
    await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
    await changes.mergeChangeRequest(admin, request.number);
    expect((await publishedModel()).model.blocks.find((block) => block.id === "uart")?.maturity).toBe("proposal");

    // And the rollback can itself be rolled back.
    const again = await rollBack(author, { sha: mergedHead });
    expect((await getWikiPage("new-page", { branch: again.branch }))).not.toBeNull();
  });

  it("commits a rollback straight onto a draft branch", async () => {
    const store = await contentStore();
    const branch = await edits.createBranch(author, "draft");
    const start = (await store.resolveHead(branch))!;
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: "# DMA\n\nRewritten.\n", expectedBlobSha: page.blobSha, message: "Rewrite" });
    const result = await rollBack(author, { sha: start, branch });
    expect(result).toMatchObject({ branch, created: false, files: 1 });
    expect((await getWikiPage("dma", { branch }))!.content).toContain("Moves data.");
  });

  it("refuses when nothing would change, and for viewers", async () => {
    const store = await contentStore();
    const head = (await store.resolveHead("main"))!;
    await expect(rollBack(author, { sha: head })).rejects.toThrow(/already match/);
    await expect(rollBack(viewer, { sha: head })).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a multi-file commit onto a branch that moved", async () => {
    const store = await contentStore();
    const head = (await store.resolveHead("main"))!;
    await edits.createBranch(author, "race");
    await expect(store.commitTree({ branch: "atlas/race", expectedHeadSha: "f".repeat(40), changes: [], message: "x" })).rejects.toThrow(/moved on/);
    expect(head).toBeTruthy();
  });
});
