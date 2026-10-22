import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/domain";

// Merging checks each reviewer's current role through lib/roles, which
// imports lib/authz's dependency chain; next-auth must not load under node.
vi.mock("@/auth", () => ({ auth: async () => null }));

const { contentStore, resetMemoryContent } = await import("@/lib/content");
const { createMemoryRepository } = await import("@/lib/content/memory-store");
const { getWikiPage, listWikiPages } = await import("@/lib/wiki");
const edits = await import("@/lib/wiki-edits");
const changes = await import("@/lib/change-requests/service");

const author: Actor = { email: "rtl@example.com", name: "Riley RTL", role: "editor" };
const reviewer: Actor = { email: "arch@example.com", name: "Arch", role: "editor" };
const admin: Actor = { email: "lead@example.com", name: "Lead", role: "admin" };
const viewer: Actor = { email: "guest@example.com", name: "Guest", role: "viewer" };

const DMA = "# DMA\n\nMoves data.\n\n## Open decisions\n\n- Timeouts\n";

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.GITHUB_APP_ID;
  process.env.ATLAS_ADMIN_EMAILS = admin.email;
  process.env.ATLAS_EDITOR_EMAILS = `${author.email},${reviewer.email}`;
  resetMemoryContent(createMemoryRepository("main", { "docs/dma.md": DMA, "docs/boot-flow.md": "# Boot flow\n\nBoots.\n" }));
  globalThis.__atlasChangeRequests = undefined;
  globalThis.__atlasMembers = new Map();
  globalThis.__atlasAudit = [];
});

async function branchWithEdit(topic = "dma timeouts", text = "- Timeouts: 1 ms\n") {
  const branch = await edits.createBranch(author, topic);
  const page = (await getWikiPage("dma", { branch }))!;
  await edits.savePage(author, { branch, slug: "dma", source: page.source.replace("- Timeouts\n", text), expectedBlobSha: page.blobSha, message: "Decide DMA timeouts" });
  return branch;
}

describe("reading the wiki at a ref", () => {
  it("lists pages on main and reads front matter", async () => {
    const branch = await edits.createBranch(author, "links");
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: `---\nblocks: [dma, dma-irq]\n---\n${page.source}`, expectedBlobSha: page.blobSha, message: "Link blocks" });
    const linked = (await getWikiPage("dma", { branch }))!;
    expect(linked.relatedBlocks).toEqual(["dma", "dma-irq"]);
    expect(linked.content.startsWith("# DMA")).toBe(true);
    expect((await listWikiPages()).map((p) => p.slug)).toEqual(["boot-flow", "dma"]);
  });

  it("returns nothing for a missing branch or a bad name", async () => {
    expect(await getWikiPage("dma", { branch: "atlas/nope" })).toBeNull();
    expect(await getWikiPage("dma", { branch: "../main" })).toBeNull();
    expect(await getWikiPage("../etc")).toBeNull();
  });
});

describe("editing", () => {
  it("commits to a branch without touching main, crediting the person", async () => {
    const branch = await branchWithEdit();
    expect(branch).toBe("atlas/dma-timeouts");
    expect((await getWikiPage("dma", { branch }))!.content).toContain("1 ms");
    expect((await getWikiPage("dma"))!.content).not.toContain("1 ms");
    const [latest] = await (await contentStore()).fileHistory(branch, "docs/dma.md", 5);
    expect(latest.message).toContain("Co-authored-by: Riley RTL <rtl@example.com>");
    expect(latest.atlasUser).toBe(author.email);
  });

  it("refuses to write main, a foreign branch, or as a viewer", async () => {
    const page = (await getWikiPage("dma"))!;
    const save = (actor: Actor, branch: string) => edits.savePage(actor, { branch, slug: "dma", source: "# x\n", expectedBlobSha: page.blobSha, message: "" });
    await expect(save(admin, "main")).rejects.toMatchObject({ status: 409 });
    await expect(save(author, "feature/vscode")).rejects.toMatchObject({ status: 409 });
    const branch = await edits.createBranch(author, "x");
    await expect(save(viewer, branch)).rejects.toMatchObject({ status: 403 });
  });

  it("detects a save based on a stale version", async () => {
    const branch = await edits.createBranch(author, "race");
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: `${page.source}first\n`, expectedBlobSha: page.blobSha, message: "first" });
    await expect(
      edits.savePage(reviewer, { branch, slug: "dma", source: `${page.source}second\n`, expectedBlobSha: page.blobSha, message: "second" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("normalises line endings and rejects broken front matter", async () => {
    const branch = await edits.createBranch(author, "eol");
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: page.source.replace(/\n/g, "\r\n"), expectedBlobSha: page.blobSha, message: "" });
    expect((await getWikiPage("dma", { branch }))!.blobSha).toBe(page.blobSha);
    await expect(
      edits.savePage(author, { branch, slug: "dma", source: "---\nblocks: dma\n---\n# DMA\n", expectedBlobSha: page.blobSha, message: "" }),
    ).rejects.toThrow(/Front matter/);
  });

  it("restores an old version as a new commit", async () => {
    const branch = await branchWithEdit();
    const [edit, original] = await (await contentStore()).fileHistory(branch, "docs/dma.md", 5);
    expect(original).toBeDefined();
    const current = (await getWikiPage("dma", { branch }))!;
    await edits.restoreVersion(author, { branch, slug: "dma", fromSha: original.sha, expectedBlobSha: current.blobSha });
    expect((await getWikiPage("dma", { branch }))!.source).toBe(DMA);
    expect(edit.sha).not.toBe(original.sha);
  });
});

describe("change requests", () => {
  it("runs the full review and merge", async () => {
    const branch = await branchWithEdit();
    const request = await changes.openChangeRequest(author, { branch, title: "DMA timeouts", description: "Closes the open decision." });

    let detail = (await changes.getChangeRequest(request.number))!;
    expect(detail.comparison?.files.map((f) => f.path)).toEqual(["docs/dma.md"]);
    expect(detail.comparison?.files[0].patch).toContain("+- Timeouts: 1 ms");
    expect((await changes.mergeReadiness(admin, detail)).reasons).toEqual(["Needs an approval from an editor or administrator who is not the author."]);

    await expect(changes.reviewChangeRequest(author, request.number, "approved", "")).rejects.toMatchObject({ status: 403 });
    await changes.reviewChangeRequest(reviewer, request.number, "approved", "");

    // A push after approval dismisses it.
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: `${page.source}\nMore.\n`, expectedBlobSha: page.blobSha, message: "More" });
    detail = (await changes.getChangeRequest(request.number))!;
    expect(detail.reviews[0].dismissed).toBe(true);
    await expect(changes.mergeChangeRequest(admin, request.number)).rejects.toThrow(/Needs an approval/);

    await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
    await expect(changes.mergeChangeRequest(reviewer, request.number)).rejects.toMatchObject({ status: 403 });
    await changes.mergeChangeRequest(admin, request.number);

    expect((await getWikiPage("dma"))!.content).toContain("1 ms");
    expect((await changes.getChangeRequest(request.number))!.request).toMatchObject({ status: "merged", mergedByEmail: admin.email });
    expect(await (await contentStore()).resolveHead(branch)).toBeNull();
    const [merge] = await (await contentStore()).fileHistory("main", "docs/dma.md", 1);
    expect(merge.message).toContain("Approved-by: arch@example.com");
  });

  it("blocks merging while a reviewer asks for changes", async () => {
    const request = await changes.openChangeRequest(author, { branch: await branchWithEdit(), title: "t", description: "" });
    await changes.reviewChangeRequest(admin, request.number, "approved", "");
    await changes.reviewChangeRequest(reviewer, request.number, "changes_requested", "Cite the spec.");
    await expect(changes.mergeChangeRequest(admin, request.number)).rejects.toThrow(/asked for changes/);
    await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
    await changes.mergeChangeRequest(admin, request.number);
  });

  it("does not count an approval from someone who has since lost editor access", async () => {
    const request = await changes.openChangeRequest(author, { branch: await branchWithEdit(), title: "t", description: "" });
    await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
    process.env.ATLAS_EDITOR_EMAILS = author.email;
    await expect(changes.mergeChangeRequest(admin, request.number)).rejects.toThrow(/Needs an approval/);
  });

  it("reports conflicts and refuses to merge them", async () => {
    const first = await changes.openChangeRequest(author, { branch: await branchWithEdit("first", "- Timeouts: 1 ms\n"), title: "a", description: "" });
    const second = await changes.openChangeRequest(author, { branch: await branchWithEdit("second", "- Timeouts: 5 ms\n"), title: "b", description: "" });
    for (const request of [first, second]) await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
    await changes.mergeChangeRequest(admin, first.number);

    const detail = (await changes.getChangeRequest(second.number))!;
    expect(detail.pull?.mergeable).toBe(false);
    expect((await changes.mergeReadiness(admin, detail)).reasons.join(" ")).toMatch(/conflicts/);
    await expect(changes.updateChangeRequestBranch(author, second.number)).rejects.toThrow(/Conflicts with main in docs\/dma.md/);
  });

  it("updates a branch that is behind but not conflicting", async () => {
    const dma = await changes.openChangeRequest(author, { branch: await branchWithEdit(), title: "dma", description: "" });
    const bootBranch = await edits.createBranch(author, "boot");
    const boot = (await getWikiPage("boot-flow", { branch: bootBranch }))!;
    await edits.savePage(author, { branch: bootBranch, slug: "boot-flow", source: `${boot.source}More.\n`, expectedBlobSha: boot.blobSha, message: "boot" });
    const bootRequest = await changes.openChangeRequest(author, { branch: bootBranch, title: "boot", description: "" });
    await changes.reviewChangeRequest(reviewer, dma.number, "approved", "");
    await changes.mergeChangeRequest(admin, dma.number);

    await changes.updateChangeRequestBranch(author, bootRequest.number);
    expect((await getWikiPage("dma", { branch: bootBranch }))!.content).toContain("1 ms");
    expect((await changes.getChangeRequest(bootRequest.number))!.comparison?.files.map((f) => f.path)).toEqual(["docs/boot-flow.md"]);
  });

  it("will not open a change request with nothing in it, or delete a branch under review", async () => {
    const empty = await edits.createBranch(author, "empty");
    await expect(changes.openChangeRequest(author, { branch: empty, title: "t", description: "" })).rejects.toThrow(/no changes/);
    const branch = await branchWithEdit();
    const request = await changes.openChangeRequest(author, { branch, title: "t", description: "" });
    await expect(edits.deleteBranch(author, branch)).rejects.toThrow(/Close this branch's change request/);
    await expect(changes.closeChangeRequest(reviewer, request.number)).rejects.toMatchObject({ status: 403 });
    await changes.closeChangeRequest(author, request.number);
    await edits.deleteBranch(author, branch);
  });
});
