"use client";

import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DocumentAsset, DocumentRevision } from "@/lib/domain";
import { Icon } from "@/components/icons";

type WikiEntry = { slug: string; title: string; relativePath: string; summary: string; relatedBlocks: string[] };

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

/** PUTs the file to its target, reporting progress as a fraction. */
function sendBytes(target: { url: string; method: string; headers: Record<string, string> }, file: File, onProgress: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(target.method, target.url);
    for (const [name, value] of Object.entries(target.headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`Storage answered ${request.status}`)));
    request.onerror = () => reject(new Error("The file could not reach storage."));
    request.send(file);
  });
}

/**
 * Reserve, send, confirm. The bytes go straight to the bucket, so a large
 * file never passes through Atlas; Atlas only records what arrived.
 */
async function uploadFile(file: File, details: { documentId?: string; blockIds: string[]; note?: string }, onProgress: (fraction: number) => void): Promise<DocumentAsset> {
  const reserve = await fetch("/api/documents/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, mimeType: file.type, byteSize: file.size, title: file.name.replace(/\.[^.]+$/, ""), ...details }),
  });
  const reserved = await reserve.json();
  if (!reserve.ok) throw new Error(reserved.error ?? "Atlas could not start this upload.");
  await sendBytes(reserved.target, file, onProgress);
  const complete = await fetch(`/api/documents/uploads/${reserved.uploadId}/complete`, { method: "POST" });
  const completed = await complete.json();
  if (!complete.ok) throw new Error(completed.error ?? "Atlas could not record this upload.");
  return completed.document;
}

function ManagedDocument({
  document,
  canEdit,
  canAdmin,
  onChange,
  onRemove,
  onError,
}: {
  document: DocumentAsset;
  canEdit: boolean;
  canAdmin: boolean;
  onChange: (document: DocumentAsset) => void;
  onRemove: () => void;
  onError: (message: string) => void;
}) {
  const [revisions, setRevisions] = useState<DocumentRevision[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const revisionRef = useRef<HTMLInputElement>(null);

  async function loadHistory() {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next) {
      const response = await fetch(`/api/documents/${document.id}/revisions`);
      const data = await response.json();
      if (response.ok) setRevisions(data.revisions);
      else onError(data.error ?? "Revision history is unavailable.");
    }
  }

  async function addRevision(file: File) {
    setProgress(0);
    try {
      const updated = await uploadFile(file, { documentId: document.id, blockIds: document.blockIds }, setProgress);
      onChange(updated);
      setRevisions(null);
      setHistoryOpen(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Atlas could not upload this revision.");
    }
    setProgress(null);
    if (revisionRef.current) revisionRef.current.value = "";
  }

  async function patch(body: Record<string, unknown>) {
    const response = await fetch(`/api/documents/${document.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (response.ok) onChange(data.document);
    else onError(data.error ?? "That change was not saved.");
  }

  async function remove() {
    if (!window.confirm(`Permanently delete "${document.title}" and all ${document.revision} revision(s)? Archiving can be undone; this cannot.`)) return;
    const response = await fetch(`/api/documents/${document.id}`, { method: "DELETE" });
    if (response.ok) onRemove();
    else onError((await response.json().catch(() => ({}))).error ?? "Atlas could not delete this document.");
  }

  return (
    <article className={`managed-document${document.archivedAt ? " archived" : ""}`}>
      <a className="document-row" href={`/api/documents/${document.id}`} target="_blank" rel="noopener">
        <span className="document-kind managed">{document.filename.split(".").pop()?.slice(0, 4).toUpperCase()}</span>
        <div><strong>{document.title}</strong><p>Revision {document.revision} · {document.ownerEmail ?? "Workspace member"}{document.archivedAt ? " · archived" : ""}</p></div>
        <div><code>{document.filename}</code><span>{formatBytes(document.byteSize)} · {document.blockIds.join(", ") || "No block link"}</span></div>
        <Icon name="external" />
      </a>
      <div className="document-actions">
        <button type="button" onClick={() => void loadHistory()} aria-expanded={historyOpen}>{historyOpen ? "Hide history" : "History"}</button>
        {canEdit && !document.archivedAt && (
          <label className="document-action-file">
            {progress === null ? "Upload new revision" : `Uploading ${Math.round(progress * 100)}%`}
            <input ref={revisionRef} type="file" disabled={progress !== null} onChange={(event) => { const file = event.target.files?.[0]; if (file) void addRevision(file); }} />
          </label>
        )}
        {canEdit && <button type="button" onClick={() => void patch({ archived: !document.archivedAt })}>{document.archivedAt ? "Restore" : "Archive"}</button>}
        {canAdmin && <button type="button" className="danger" onClick={() => void remove()}>Delete</button>}
      </div>
      {historyOpen && (
        <ol className="revision-list">
          {revisions === null && <li>Loading…</li>}
          {revisions?.map((revision) => (
            <li key={revision.revision}>
              <a href={`/api/documents/${document.id}?revision=${revision.revision}`} target="_blank" rel="noopener">Revision {revision.revision}</a>
              <span>{revision.filename} · {formatBytes(revision.byteSize)} · {revision.uploaderEmail ?? "Workspace member"} · {new Date(revision.createdAt).toLocaleString()}</span>
              {revision.note && <small>{revision.note}</small>}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

export function DocumentLibrary({
  initialDocuments,
  wiki,
  canEdit,
  canAdmin,
  maxBytes,
  notice,
}: {
  initialDocuments: DocumentAsset[];
  wiki: WikiEntry[];
  canEdit: boolean;
  canAdmin: boolean;
  /** The largest file this deployment accepts. */
  maxBytes: number;
  /** Explains an empty register when no durable storage is attached. */
  notice?: string;
}) {
  const params = useSearchParams();
  const initialBlock = params.get("block") ?? "";
  const [documents, setDocuments] = useState(initialDocuments);
  const [showArchived, setShowArchived] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [blockIds, setBlockIds] = useState(initialBlock);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setError("Choose a document first."); return; }
    if (file.size > maxBytes) { setError(`Documents must be ${formatBytes(maxBytes)} or smaller.`); return; }
    setProgress(0); setError("");
    try {
      const document = await uploadFile(file, { blockIds: blockIds.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20) }, setProgress);
      setDocuments((current) => [document, ...current]);
      if (fileRef.current) fileRef.current.value = "";
      setBlockIds(initialBlock);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Atlas could not upload this document.");
    }
    setProgress(null);
  }

  const replace = (next: DocumentAsset) => setDocuments((current) => current.map((item) => (item.id === next.id ? next : item)));
  const visible = documents.filter((document) => showArchived || !document.archivedAt);
  const archivedCount = documents.length - documents.filter((document) => !document.archivedAt).length;

  return (
    <div className="documents-page">
      <header className="documents-heading"><div><h1>Evidence library</h1><p>Git-backed design sources stay canonical. Managed files supplement them with ownership, versions, and architecture links.</p></div><span className="authority-key"><i />Canonical in Git <i />Managed attachment</span></header>
      {canEdit && <section className="upload-bench"><div><Icon name="upload" /><span><strong>Add supporting evidence</strong><small>PDF, image, Markdown, text, Word, or PowerPoint · {formatBytes(maxBytes)} maximum</small></span></div><label>File<input ref={fileRef} type="file" /></label><label>Block IDs<input value={blockIds} onChange={(event) => setBlockIds(event.target.value)} placeholder="Optional: dma, coral-core" /></label><button type="button" onClick={() => void upload()} disabled={progress !== null}>{progress === null ? "Add document" : `Uploading ${Math.round(progress * 100)}%`}</button></section>}
      {notice && <p className="storage-notice" role="status">{notice}</p>}
      {error && <div className="page-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      <section className="document-register">
        <header><h2>Repository sources</h2><span>{wiki.length} current files</span></header>
        {wiki.map((source) => <a className="document-row" href={`/wiki/${source.slug}`} key={source.slug}><span className="document-kind canonical">MD</span><div><strong>{source.title}</strong><p>{source.summary}</p></div><div><code>{source.relativePath}</code><span>{source.relatedBlocks.length} block links</span></div><Icon name="arrow" /></a>)}
      </section>
      <section className="document-register">
        <header>
          <h2>Managed attachments</h2>
          <span>
            {visible.length} files
            {canEdit && archivedCount > 0 && <button type="button" className="register-toggle" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "Hide" : "Show"} {archivedCount} archived</button>}
          </span>
        </header>
        {visible.map((document) => (
          <ManagedDocument
            key={document.id}
            document={document}
            canEdit={canEdit}
            canAdmin={canAdmin}
            onChange={replace}
            onRemove={() => setDocuments((current) => current.filter((item) => item.id !== document.id))}
            onError={setError}
          />
        ))}
        {!visible.length && <div className="register-empty"><Icon name="documents" /><span><strong>No managed attachments yet</strong>Upload supporting evidence without changing the canonical wiki.</span></div>}
      </section>
    </div>
  );
}
