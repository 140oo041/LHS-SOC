import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { PoolClient } from "pg";
import { hasDatabase, query, transaction } from "@/lib/db";
import { WORKSPACE_SLUG, type Actor, type DocumentAsset, type DocumentRevision } from "@/lib/domain";
import { ensureActor } from "@/lib/repository";
import { recordAudit } from "@/lib/roles";
import { deleteObject } from "@/lib/storage";

/**
 * Managed documents: files that supplement the Git-backed sources.
 *
 * Bytes never pass through Atlas on a host. An upload is reserved here, the
 * browser sends the file straight to the bucket, and completing the upload
 * checks what actually arrived before recording it as a document or as the
 * next revision of one.
 */

export const ALLOWED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const UPLOAD_WINDOW_MS = 15 * 60 * 1000;

export type PendingUpload = {
  id: string;
  storageKey: string;
  uploaderEmail: string;
  documentId: string | null;
  title: string;
  filename: string;
  mimeType: string;
  declaredBytes: number;
  blockIds: string[];
  note: string;
  expiresAt: string;
};

type MemoryDocument = DocumentAsset & { revisions: Array<DocumentRevision & { storageKey: string }> };

type MemoryDocuments = { documents: MemoryDocument[]; pending: Map<string, PendingUpload> };

declare global {
  var __atlasDocuments: MemoryDocuments | undefined;
}

function memory(): MemoryDocuments {
  globalThis.__atlasDocuments ??= { documents: [], pending: new Map() };
  return globalThis.__atlasDocuments;
}

const now = () => new Date().toISOString();
const iso = (value: unknown) => new Date(String(value)).toISOString();

export class DocumentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 413 | 415,
  ) {
    super(message);
  }
}

function publicDocument(document: MemoryDocument): DocumentAsset {
  const { revisions, ...rest } = document;
  void revisions;
  return structuredClone(rest);
}

function mapDocument(row: Record<string, unknown>): DocumentAsset {
  return {
    id: String(row.id),
    title: String(row.title),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    storageKey: String(row.storage_key),
    revision: Number(row.revision),
    ownerEmail: row.owner_email ? String(row.owner_email) : undefined,
    blockIds: (row.block_ids ?? []) as string[],
    taskIds: (row.task_ids ?? []) as string[],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at ?? row.created_at),
    archivedAt: row.archived_at ? iso(row.archived_at) : undefined,
  };
}

const DOCUMENT_SELECT = `SELECT d.*, u.email AS owner_email FROM document_assets d
  JOIN workspaces w ON w.id = d.workspace_id LEFT JOIN users u ON u.id = d.owner_id`;

export async function listDocuments(options: { includeArchived?: boolean } = {}): Promise<DocumentAsset[]> {
  if (!hasDatabase()) {
    return memory()
      .documents.filter((document) => options.includeArchived || !document.archivedAt)
      .map(publicDocument);
  }
  const result = await query(
    `${DOCUMENT_SELECT} WHERE w.slug = $1 AND ($2 OR d.archived_at IS NULL) ORDER BY d.updated_at DESC`,
    [WORKSPACE_SLUG, Boolean(options.includeArchived)],
  );
  return result.rows.map(mapDocument);
}

export async function getDocument(id: string): Promise<DocumentAsset | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (!hasDatabase()) {
    const document = memory().documents.find((item) => item.id === id);
    return document ? publicDocument(document) : null;
  }
  const result = await query(`${DOCUMENT_SELECT} WHERE w.slug = $1 AND d.id = $2`, [WORKSPACE_SLUG, id]);
  return result.rows[0] ? mapDocument(result.rows[0]) : null;
}

/** Where one revision's bytes live, and how to present them. */
export async function getDocumentRevision(
  id: string,
  revision?: number,
): Promise<(DocumentRevision & { storageKey: string }) | null> {
  if (!hasDatabase()) {
    const document = memory().documents.find((item) => item.id === id);
    const wanted = revision ?? document?.revision;
    return document?.revisions.find((item) => item.revision === wanted) ?? null;
  }
  const result = await query(
    `SELECT r.*, u.email AS uploader_email FROM document_revisions r
     JOIN document_assets d ON d.id = r.document_id LEFT JOIN users u ON u.id = r.uploaded_by
     WHERE r.document_id = $1 AND r.revision = COALESCE($2, d.revision)`,
    [id, revision ?? null],
  );
  const row = result.rows[0];
  return row ? { ...mapRevision(row), storageKey: String(row.storage_key) } : null;
}

function mapRevision(row: Record<string, unknown>): DocumentRevision {
  return {
    revision: Number(row.revision),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    note: String(row.note ?? ""),
    uploaderEmail: row.uploader_email ? String(row.uploader_email) : undefined,
    createdAt: iso(row.created_at),
  };
}

export async function listDocumentRevisions(id: string): Promise<DocumentRevision[]> {
  if (!hasDatabase()) {
    const document = memory().documents.find((item) => item.id === id);
    return (document?.revisions ?? [])
      .map(({ storageKey, ...revision }) => {
        void storageKey;
        return revision;
      })
      .sort((a, b) => b.revision - a.revision);
  }
  const result = await query(
    `SELECT r.*, u.email AS uploader_email FROM document_revisions r LEFT JOIN users u ON u.id = r.uploaded_by
     WHERE r.document_id = $1 ORDER BY r.revision DESC`,
    [id],
  );
  return result.rows.map(mapRevision);
}

export type UploadRequest = {
  filename: string;
  mimeType: string;
  byteSize: number;
  title?: string;
  blockIds: string[];
  documentId?: string;
  note: string;
};

/**
 * Reserves a storage key for an upload the browser is about to send.
 *
 * The key is chosen here, never by the client, so an upload cannot land on
 * or overwrite another document's bytes.
 */
export async function reserveUpload(actor: Actor, request: UploadRequest, limit: number): Promise<PendingUpload> {
  if (!ALLOWED_DOCUMENT_TYPES.has(request.mimeType)) throw new DocumentError("This document type is not allowed", 415);
  if (request.byteSize > limit) {
    throw new DocumentError(`Documents must be ${Math.floor(limit / (1024 * 1024))} MB or smaller`, 413);
  }
  if (request.documentId) {
    const existing = await getDocument(request.documentId);
    if (!existing) throw new DocumentError("Document not found", 404);
    if (existing.archivedAt) throw new DocumentError("Restore this document before adding a revision", 409);
  }

  const id = randomUUID();
  const extension = extname(request.filename).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 10);
  const pending: PendingUpload = {
    id,
    storageKey: `coral/documents/${request.documentId ?? "new"}/${id}${extension}`,
    uploaderEmail: actor.email,
    documentId: request.documentId ?? null,
    title: (request.title || request.filename.replace(/\.[^.]+$/, "")).trim().slice(0, 180),
    filename: request.filename.slice(0, 240),
    mimeType: request.mimeType,
    declaredBytes: request.byteSize,
    blockIds: request.blockIds,
    note: request.note,
    expiresAt: new Date(Date.now() + UPLOAD_WINDOW_MS).toISOString(),
  };

  if (!hasDatabase()) {
    memory().pending.set(id, pending);
    return pending;
  }
  await query(
    `INSERT INTO pending_uploads (id, storage_key, uploader_email, document_id, title, filename, mime_type, declared_bytes, block_ids, note, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, pending.storageKey, pending.uploaderEmail, pending.documentId, pending.title, pending.filename, pending.mimeType, pending.declaredBytes, pending.blockIds, pending.note, pending.expiresAt],
  );
  return pending;
}

function mapPending(row: Record<string, unknown>): PendingUpload {
  return {
    id: String(row.id),
    storageKey: String(row.storage_key),
    uploaderEmail: String(row.uploader_email),
    documentId: row.document_id ? String(row.document_id) : null,
    title: String(row.title),
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    declaredBytes: Number(row.declared_bytes),
    blockIds: (row.block_ids ?? []) as string[],
    note: String(row.note ?? ""),
    expiresAt: iso(row.expires_at),
  };
}

/** The reservation, if it exists and belongs to this person. */
export async function getPendingUpload(actor: Actor, id: string): Promise<PendingUpload> {
  let pending: PendingUpload | undefined;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DocumentError("Upload not found", 404);
  if (!hasDatabase()) pending = memory().pending.get(id);
  else {
    const result = await query("SELECT * FROM pending_uploads WHERE id = $1", [id]);
    pending = result.rows[0] ? mapPending(result.rows[0]) : undefined;
  }
  if (!pending) throw new DocumentError("Upload not found", 404);
  if (pending.uploaderEmail !== actor.email) throw new DocumentError("This upload belongs to someone else", 403);
  if (pending.expiresAt <= now()) throw new DocumentError("This upload expired. Start it again.", 410);
  return pending;
}

/**
 * Records a finished upload as a new document or as its next revision.
 *
 * `stored` is what the bucket reports, not what the browser claimed, so a
 * client cannot slip a larger file past the size limit by lying about it.
 */
export async function completeUpload(
  actor: Actor,
  pending: PendingUpload,
  stored: { byteSize: number } | null,
  limit: number,
): Promise<DocumentAsset> {
  if (!stored) throw new DocumentError("The file never reached storage. Try the upload again.", 409);
  if (stored.byteSize > limit) {
    await deleteObject(pending.storageKey);
    await discardPending(pending.id);
    throw new DocumentError(`Documents must be ${Math.floor(limit / (1024 * 1024))} MB or smaller`, 413);
  }

  const revision = { filename: pending.filename, mimeType: pending.mimeType, byteSize: stored.byteSize, note: pending.note };
  const document = hasDatabase()
    ? await transaction((client) => completeInDatabase(client, actor, pending, revision))
    : completeInMemory(actor, pending, revision);

  await discardPending(pending.id);
  await recordAudit(actor, pending.documentId ? "document.revise" : "document.create", document.id, { revision: document.revision });
  return document;
}

function completeInMemory(actor: Actor, pending: PendingUpload, revision: Omit<DocumentRevision, "revision" | "createdAt">): DocumentAsset {
  const createdAt = now();
  if (pending.documentId) {
    const document = memory().documents.find((item) => item.id === pending.documentId);
    if (!document) throw new DocumentError("Document not found", 404);
    const next = Math.max(...document.revisions.map((item) => item.revision)) + 1;
    document.revisions.push({ ...revision, revision: next, uploaderEmail: actor.email, createdAt, storageKey: pending.storageKey });
    Object.assign(document, { ...revision, revision: next, storageKey: pending.storageKey, updatedAt: createdAt });
    return publicDocument(document);
  }
  const document: MemoryDocument = {
    id: randomUUID(),
    title: pending.title,
    ...revision,
    storageKey: pending.storageKey,
    revision: 1,
    ownerEmail: actor.email,
    blockIds: pending.blockIds,
    taskIds: [],
    createdAt,
    updatedAt: createdAt,
    revisions: [{ ...revision, revision: 1, uploaderEmail: actor.email, createdAt, storageKey: pending.storageKey }],
  };
  memory().documents.unshift(document);
  return publicDocument(document);
}

async function completeInDatabase(
  client: PoolClient,
  actor: Actor,
  pending: PendingUpload,
  revision: Omit<DocumentRevision, "revision" | "createdAt">,
): Promise<DocumentAsset> {
  await ensureActor(actor);
  const uploader = (await client.query("SELECT id FROM users WHERE email = $1", [actor.email])).rows[0]?.id ?? null;
  let documentId = pending.documentId;
  let next = 1;

  if (documentId) {
    // The row lock serialises concurrent revisions of one document, so two
    // people uploading at once get consecutive numbers, not the same one.
    const locked = await client.query("SELECT revision FROM document_assets WHERE id = $1 FOR UPDATE", [documentId]);
    if (!locked.rowCount) throw new DocumentError("Document not found", 404);
    next = Number(locked.rows[0].revision) + 1;
    await client.query(
      `UPDATE document_assets SET revision = $2, storage_key = $3, filename = $4, mime_type = $5, byte_size = $6, updated_at = now()
       WHERE id = $1`,
      [documentId, next, pending.storageKey, revision.filename, revision.mimeType, revision.byteSize],
    );
  } else {
    documentId = randomUUID();
    await client.query(
      `INSERT INTO document_assets (id, workspace_id, title, filename, mime_type, byte_size, storage_key, owner_id, block_ids)
       SELECT $1, w.id, $2, $3, $4, $5, $6, $7, $8 FROM workspaces w WHERE w.slug = $9`,
      [documentId, pending.title, revision.filename, revision.mimeType, revision.byteSize, pending.storageKey, uploader, pending.blockIds, WORKSPACE_SLUG],
    );
  }

  await client.query(
    `INSERT INTO document_revisions (document_id, revision, storage_key, filename, mime_type, byte_size, note, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [documentId, next, pending.storageKey, revision.filename, revision.mimeType, revision.byteSize, revision.note, uploader],
  );
  const result = await client.query(`${DOCUMENT_SELECT} WHERE d.id = $1`, [documentId]);
  return mapDocument(result.rows[0]);
}

async function discardPending(id: string) {
  if (!hasDatabase()) memory().pending.delete(id);
  else await query("DELETE FROM pending_uploads WHERE id = $1", [id]);
}

export async function updateDocument(
  actor: Actor,
  id: string,
  changes: { archived?: boolean; title?: string; blockIds?: string[] },
): Promise<DocumentAsset> {
  const existing = await getDocument(id);
  if (!existing) throw new DocumentError("Document not found", 404);

  if (!hasDatabase()) {
    const document = memory().documents.find((item) => item.id === id)!;
    if (changes.title !== undefined) document.title = changes.title;
    if (changes.blockIds !== undefined) document.blockIds = changes.blockIds;
    if (changes.archived !== undefined) document.archivedAt = changes.archived ? now() : undefined;
    document.updatedAt = now();
  } else {
    await ensureActor(actor);
    await query(
      `UPDATE document_assets SET
         title = COALESCE($2, title),
         block_ids = COALESCE($3, block_ids),
         archived_at = CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN COALESCE(archived_at, now()) ELSE NULL END,
         archived_by = CASE WHEN $4::boolean IS NULL THEN archived_by WHEN $4 THEN (SELECT id FROM users WHERE email = $5) ELSE NULL END,
         updated_at = now()
       WHERE id = $1`,
      [id, changes.title ?? null, changes.blockIds ?? null, changes.archived ?? null, actor.email],
    );
  }
  if (changes.archived !== undefined) await recordAudit(actor, changes.archived ? "document.archive" : "document.restore", id);
  return (await getDocument(id))!;
}

/**
 * Removes a document, every revision's bytes, and its links from tasks.
 *
 * Rows go first, inside a transaction; bytes go after. A failure deleting
 * bytes leaves orphaned objects, which cost storage but never show up as a
 * document that cannot be opened.
 */
export async function deleteDocument(actor: Actor, id: string) {
  const existing = await getDocument(id);
  if (!existing) throw new DocumentError("Document not found", 404);
  let keys: string[];

  if (!hasDatabase()) {
    const index = memory().documents.findIndex((item) => item.id === id);
    keys = memory().documents[index].revisions.map((item) => item.storageKey);
    memory().documents.splice(index, 1);
    for (const task of globalThis.__atlasMemory?.tasks ?? []) task.documentIds = task.documentIds.filter((item) => item !== id);
  } else {
    keys = await transaction(async (client) => {
      const revisions = await client.query("SELECT storage_key FROM document_revisions WHERE document_id = $1", [id]);
      await client.query("UPDATE tasks SET document_ids = array_remove(document_ids, $1::uuid) WHERE $1::uuid = ANY(document_ids)", [id]);
      await client.query("DELETE FROM document_assets WHERE id = $1", [id]);
      return revisions.rows.map((row) => String(row.storage_key));
    });
  }

  await recordAudit(actor, "document.delete", id, { title: existing.title });
  for (const key of keys) {
    await deleteObject(key).catch((error) => console.error(`Could not delete stored object ${key}`, error));
  }
}

/** Drops expired reservations and any bytes they left in the bucket. */
export async function sweepPendingUploads() {
  let expired: PendingUpload[];
  if (!hasDatabase()) {
    expired = [...memory().pending.values()].filter((pending) => pending.expiresAt <= now());
  } else {
    expired = (await query("SELECT * FROM pending_uploads WHERE expires_at <= now()")).rows.map(mapPending);
  }
  for (const pending of expired) {
    await deleteObject(pending.storageKey).catch((error) => console.error(`Could not delete stored object ${pending.storageKey}`, error));
    await discardPending(pending.id);
  }
  return expired.length;
}
