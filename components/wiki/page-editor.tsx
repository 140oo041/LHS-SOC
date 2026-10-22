"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createBranchAction, savePageAction } from "@/app/(workspace)/wiki/actions";
import { unifiedPatch } from "@/lib/content/diff";
import { PatchView } from "@/components/wiki/diff-view";

const stripFrontMatter = (source: string) => source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

const pageHref = (slug: string, branch: string) => `/wiki/${slug}?branch=${encodeURIComponent(branch)}`;

/** Editing starts on a draft branch; from the published wiki, make one first. */
export function StartDraft({ slug, from, title }: { slug: string; from: string; title: string }) {
  const router = useRouter();
  const [topic, setTopic] = useState(`Update ${title}`);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="wiki-start-draft"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await createBranchAction(topic, from);
          if (!result.ok) setError(result.error);
          else router.replace(`/wiki/${slug}/edit?branch=${encodeURIComponent(result.branch)}`);
        });
      }}
    >
      <h2>Start a draft</h2>
      <p>The published wiki changes only through reviewed change requests. Your edits go on a new branch, which you can keep adding to and then propose for review.</p>
      <label><span>What is this change about?</span><input value={topic} onChange={(event) => setTopic(event.target.value)} required maxLength={60} autoFocus /></label>
      <button className="primary-button" type="submit" disabled={pending}>{pending ? "Creating branch…" : "Create branch and edit"}</button>
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>
  );
}

export function PageEditor({
  slug,
  branch,
  initialSource,
  initialBlobSha,
}: {
  slug: string;
  branch: string;
  initialSource: string;
  /** null when this creates the page. */
  initialBlobSha: string | null;
}) {
  const router = useRouter();
  const [source, setSource] = useState(initialSource);
  const [blobSha, setBlobSha] = useState(initialBlobSha);
  const [baseline, setBaseline] = useState(initialSource);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ source: string; blobSha: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = source !== baseline;

  // Leaving with unsaved text loses it; the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const conflictPatch = useMemo(() => (conflict ? unifiedPatch(conflict.source, source) : ""), [conflict, source]);

  function save(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await savePageAction({ branch, slug, source, expectedBlobSha: blobSha, message: message || `${initialBlobSha ? "Update" : "Add"} ${slug}` });
      if (result.ok) {
        setBaseline(source);
        router.push(pageHref(slug, branch));
        router.refresh();
        return;
      }
      setError(result.error);
      if (result.conflict) setConflict(result.conflict);
    });
  }

  return (
    <form className="wiki-editor" onSubmit={save}>
      <div className="wiki-editor-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!preview} onClick={() => setPreview(false)}>Write</button>
        <button type="button" role="tab" aria-selected={preview} onClick={() => setPreview(true)}>Preview</button>
        <span>{dirty ? "Unsaved changes" : "No changes yet"}</span>
      </div>
      {preview ? (
        <div className="wiki-article wiki-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontMatter(source)}</ReactMarkdown></div>
      ) : (
        <textarea
          aria-label="Page Markdown"
          value={source}
          onChange={(event) => setSource(event.target.value)}
          spellCheck
          rows={28}
        />
      )}
      <p className="wiki-editor-hint">Markdown. Link architecture blocks with front matter at the top: <code>---</code> / <code>blocks: [dma, coral-core]</code> / <code>---</code>.</p>

      {conflict && (
        <section className="wiki-conflict" aria-live="polite">
          <h2>Someone else saved first</h2>
          <p>Below is how your text differs from the version now on <strong>{branch}</strong> (− theirs, + yours). Keep yours to save it on top of theirs, or take theirs and lose your edits.</p>
          <PatchView patch={conflictPatch || "@@ -1 +1 @@\n Your text matches theirs."} />
          <div>
            <button type="button" className="secondary-button" onClick={() => { setBlobSha(conflict.blobSha); setConflict(null); setError(""); }}>Keep mine</button>
            <button type="button" className="secondary-button" onClick={() => { setSource(conflict.source); setBaseline(conflict.source); setBlobSha(conflict.blobSha); setConflict(null); setError(""); }}>Take theirs</button>
          </div>
        </section>
      )}

      <footer>
        <label><span>Describe the change</span><input value={message} onChange={(event) => setMessage(event.target.value)} placeholder={`${initialBlobSha ? "Update" : "Add"} ${slug}`} maxLength={120} /></label>
        <Link className="secondary-button" href={initialBlobSha ? pageHref(slug, branch) : `/wiki?branch=${encodeURIComponent(branch)}`}>Cancel</Link>
        <button className="primary-button" type="submit" disabled={pending || Boolean(conflict) || (!dirty && Boolean(initialBlobSha))}>
          {pending ? "Saving…" : `Commit to ${branch}`}
        </button>
      </footer>
      {error && !conflict && <p role="alert" className="form-error">{error}</p>}
    </form>
  );
}
