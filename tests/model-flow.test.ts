import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/domain";

vi.mock("@/auth", () => ({ auth: async () => null }));

const { resetMemoryContent } = await import("@/lib/content");
const { createMemoryRepository } = await import("@/lib/content/memory-store");
const { branchModelChanges, modelAt, publishedModel, snapshotWithChanges } = await import("@/lib/model/at");
const { editModel, restoreModel } = await import("@/lib/model-edits");
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
  resetMemoryContent(createMemoryRepository("main", { "architecture/soc.yaml": MODEL, "docs/dma.md": "# DMA\n\nMoves data.\n" }));
  globalThis.__atlasChangeRequests = undefined;
  globalThis.__atlasMembers = new Map();
  globalThis.__atlasAudit = [];
});

const maturity = { op: "updateBlock" as const, id: "uart", fields: { maturity: "specified" as const } };

describe("the model on a branch", () => {
  it("edits on a branch, shows the change against main, and publishes it by merge", async () => {
    const branch = await edits.createBranch(author, "uart spec");
    const before = (await modelAt({ branch }))!;
    await editModel(author, { branch, expectedBlobSha: before.blobSha, edit: maturity });

    // The page and the model can change together on one branch.
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: `${page.source}\nUART is specified.\n`, expectedBlobSha: page.blobSha, message: "Note" });

    expect((await modelAt({ branch }))!.model.blocks.find((block) => block.id === "uart")?.maturity).toBe("specified");
    expect((await publishedModel()).model.blocks.find((block) => block.id === "uart")?.maturity).toBe("proposal");

    const found = (await branchModelChanges(branch))!;
    expect(found.diff.blocks).toEqual([{ id: "uart", name: "UART", status: "changed", fields: [{ field: "maturity", before: "proposal", after: "specified" }] }]);
    expect(snapshotWithChanges(found).changes?.blocks.uart).toBe("changed");

    const request = await changes.openChangeRequest(author, { branch, title: "Specify UART", description: "" });
    const detail = (await changes.getChangeRequest(request.number))!;
    expect(detail.comparison?.files.map((file) => file.path).sort()).toEqual(["architecture/soc.yaml", "docs/dma.md"]);
    await changes.reviewChangeRequest(reviewer, request.number, "approved", "");
    await changes.mergeChangeRequest(admin, request.number);

    expect((await publishedModel()).model.blocks.find((block) => block.id === "uart")?.maturity).toBe("specified");
    expect((await getWikiPage("dma"))!.content).toContain("UART is specified.");
  });

  it("refuses edits on main, by viewers, and from a stale model", async () => {
    const main = await publishedModel();
    await expect(editModel(admin, { branch: "main", expectedBlobSha: main.blobSha, edit: maturity })).rejects.toMatchObject({ status: 409 });
    const branch = await edits.createBranch(author, "stale");
    await expect(editModel(viewer, { branch, expectedBlobSha: main.blobSha, edit: maturity })).rejects.toMatchObject({ status: 403 });
    await editModel(author, { branch, expectedBlobSha: main.blobSha, edit: maturity });
    await expect(
      editModel(reviewer, { branch, expectedBlobSha: main.blobSha, edit: { op: "updateBlock", id: "uart", fields: { name: "Serial" } } }),
    ).rejects.toThrow(/changed on atlas\/stale/);
  });

  it("undoes an edit by committing the version before it", async () => {
    const branch = await edits.createBranch(author, "undo");
    const before = (await modelAt({ branch }))!;
    const moved = await editModel(author, { branch, expectedBlobSha: before.blobSha, edit: { op: "moveNode", canvas: "coral-soc", id: "uart", x: 10, y: 10, width: 200, height: 100 } });
    const undone = await restoreModel(author, { branch, expectedBlobSha: moved.blobSha, blobSha: before.blobSha });
    expect(undone.blobSha).toBe(before.blobSha);
    expect((await modelAt({ branch }))!.text).toBe(before.text);
    await expect(restoreModel(author, { branch, expectedBlobSha: moved.blobSha, blobSha: before.blobSha })).rejects.toThrow(/changed on/);
  });

  it("refuses an edit that would break the model, without committing", async () => {
    const branch = await edits.createBranch(author, "broken");
    const head = (await modelAt({ branch }))!;
    await expect(
      editModel(author, { branch, expectedBlobSha: head.blobSha, edit: { op: "updateBlock", id: "uart", fields: { owner: "nobody" } } }),
    ).rejects.toThrow(/invalid/);
    expect((await modelAt({ branch }))!.blobSha).toBe(head.blobSha);
  });

  it("reports no model changes for a branch that only edits pages", async () => {
    const branch = await edits.createBranch(author, "pages only");
    const page = (await getWikiPage("dma", { branch }))!;
    await edits.savePage(author, { branch, slug: "dma", source: `${page.source}more\n`, expectedBlobSha: page.blobSha, message: "More" });
    const found = (await branchModelChanges(branch))!;
    expect(found.diff).toEqual({ blocks: [], connections: [], sections: [] });
  });
});
