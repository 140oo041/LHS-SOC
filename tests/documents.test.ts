import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/domain";
import {
  completeUpload,
  deleteDocument,
  DocumentError,
  getDocumentRevision,
  getPendingUpload,
  listDocumentRevisions,
  listDocuments,
  reserveUpload,
  sweepPendingUploads,
  updateDocument,
} from "@/lib/documents";

const editor: Actor = { email: "rtl@example.com", name: "RTL", role: "editor" };
const other: Actor = { email: "other@example.com", name: "Other", role: "editor" };
const LIMIT = 10 * 1024 * 1024;

const pdf = (overrides: Partial<Parameters<typeof reserveUpload>[1]> = {}) => ({
  filename: "dma-spec.pdf",
  mimeType: "application/pdf",
  byteSize: 1000,
  blockIds: ["dma"],
  note: "",
  ...overrides,
});

beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.S3_BUCKET;
  globalThis.__atlasDocuments = { documents: [], pending: new Map() };
  globalThis.__atlasAudit = [];
});

async function upload(actor: Actor, request = pdf(), stored = { byteSize: request.byteSize }) {
  const pending = await reserveUpload(actor, request, LIMIT);
  return completeUpload(actor, await getPendingUpload(actor, pending.id), stored, LIMIT);
}

describe("uploads", () => {
  it("creates a document at revision 1 and numbers later revisions in order", async () => {
    const first = await upload(editor);
    expect(first).toMatchObject({ title: "dma-spec", revision: 1, blockIds: ["dma"], ownerEmail: editor.email });

    const second = await upload(other, pdf({ documentId: first.id, filename: "dma-spec-v2.pdf", note: "Adds timeouts" }), { byteSize: 2000 });
    const third = await upload(editor, pdf({ documentId: first.id }));
    expect([second.revision, third.revision]).toEqual([2, 3]);
    expect(await listDocuments()).toHaveLength(1);

    const history = await listDocumentRevisions(first.id);
    expect(history.map((r) => [r.revision, r.uploaderEmail])).toEqual([[3, editor.email], [2, other.email], [1, editor.email]]);
    expect(history[1]).toMatchObject({ filename: "dma-spec-v2.pdf", byteSize: 2000, note: "Adds timeouts" });

    const old = await getDocumentRevision(first.id, 1);
    const current = await getDocumentRevision(first.id);
    expect(old?.storageKey).not.toBe(current?.storageKey);
    expect(current?.revision).toBe(3);
  });

  it("chooses the storage key itself", async () => {
    const pending = await reserveUpload(editor, pdf({ filename: "../../etc/passwd.pdf" }), LIMIT);
    expect(pending.storageKey).toMatch(/^coral\/documents\/new\/[0-9a-f-]{36}\.pdf$/);
  });

  it("refuses types and sizes outside policy before reserving", async () => {
    await expect(reserveUpload(editor, pdf({ mimeType: "application/x-msdownload" }), LIMIT)).rejects.toMatchObject({ status: 415 });
    await expect(reserveUpload(editor, pdf({ byteSize: LIMIT + 1 }), LIMIT)).rejects.toMatchObject({ status: 413 });
  });

  it("checks the stored size, not the declared one", async () => {
    const pending = await reserveUpload(editor, pdf(), LIMIT);
    await expect(completeUpload(editor, pending, { byteSize: LIMIT + 1 }, LIMIT)).rejects.toMatchObject({ status: 413 });
    expect(await listDocuments()).toHaveLength(0);
    await expect(getPendingUpload(editor, pending.id)).rejects.toMatchObject({ status: 404 });
  });

  it("will not complete an upload whose bytes never arrived", async () => {
    const pending = await reserveUpload(editor, pdf(), LIMIT);
    await expect(completeUpload(editor, pending, null, LIMIT)).rejects.toMatchObject({ status: 409 });
  });

  it("lets only the uploader complete, and only before it expires", async () => {
    const pending = await reserveUpload(editor, pdf(), LIMIT);
    await expect(getPendingUpload(other, pending.id)).rejects.toMatchObject({ status: 403 });
    globalThis.__atlasDocuments!.pending.get(pending.id)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(getPendingUpload(editor, pending.id)).rejects.toBeInstanceOf(DocumentError);
    expect(await sweepPendingUploads()).toBe(1);
    expect(globalThis.__atlasDocuments!.pending.size).toBe(0);
  });
});

describe("archive and delete", () => {
  it("hides archived documents unless asked, and refuses revisions to them", async () => {
    const document = await upload(editor);
    await updateDocument(editor, document.id, { archived: true });
    expect(await listDocuments()).toHaveLength(0);
    expect(await listDocuments({ includeArchived: true })).toHaveLength(1);
    await expect(reserveUpload(editor, pdf({ documentId: document.id }), LIMIT)).rejects.toMatchObject({ status: 409 });
    await updateDocument(editor, document.id, { archived: false });
    expect(await listDocuments()).toHaveLength(1);
  });

  it("removes the document and its links from tasks", async () => {
    const document = await upload(editor);
    const { listTasks } = await import("@/lib/repository");
    const [task] = await listTasks();
    globalThis.__atlasMemory!.tasks[0].documentIds.push(document.id);
    await deleteDocument(editor, document.id);
    expect(await listDocuments({ includeArchived: true })).toHaveLength(0);
    expect(globalThis.__atlasMemory!.tasks.find((t) => t.id === task.id)?.documentIds).not.toContain(document.id);
    expect(globalThis.__atlasAudit?.[0]).toMatchObject({ action: "document.delete", target: document.id });
  });
});
