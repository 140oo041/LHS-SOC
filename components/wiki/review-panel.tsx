"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  closeChangeRequestAction,
  mergeAction,
  openChangeRequestAction,
  reviewAction,
  updateBranchAction,
  type ActionResult,
} from "@/app/(workspace)/wiki/actions";

function useAction() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const run = (work: () => Promise<ActionResult>, after?: () => void) => {
    setError("");
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
      else {
        after?.();
        router.refresh();
      }
    });
  };
  return { error, pending, run };
}

export function ProposeForm({ branch, initialTitle = "" }: { branch: string; initialTitle?: string }) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="wiki-start-draft"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await openChangeRequestAction({ branch, title, description });
          if (!result.ok) setError(result.error);
          else router.push(`/wiki/changes/${result.number}`);
        });
      }}
    >
      <label><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={120} placeholder="Decide DMA timeout behaviour" /></label>
      <label><span>Why this change</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={4000} placeholder="What decision does this record, and what evidence supports it?" /></label>
      <button className="primary-button" type="submit" disabled={pending}>{pending ? "Opening…" : "Open change request"}</button>
      {error && <p role="alert" className="form-error">{error}</p>}
    </form>
  );
}

export function ReviewPanel({
  number,
  canReview,
  canComment,
  canMerge,
  canClose,
  canUpdate,
  readiness,
}: {
  number: number;
  canReview: boolean;
  canComment: boolean;
  canMerge: boolean;
  canClose: boolean;
  canUpdate: boolean;
  readiness: { allowed: boolean; reasons: string[] };
}) {
  const [body, setBody] = useState("");
  const { error, pending, run } = useAction();
  const conflicting = readiness.reasons.some((reason) => reason.includes("conflicts"));

  return (
    <section className="review-panel">
      {canComment && (
        <div className="review-compose">
          <label><span>{canReview ? "Your review" : "Comment"}</span><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={4000} placeholder={canReview ? "Optional when approving" : "Authors can comment but not approve their own change"} /></label>
          <div>
            {canReview && <button type="button" className="primary-button" disabled={pending} onClick={() => run(() => reviewAction(number, "approved", body), () => setBody(""))}>Approve</button>}
            {canReview && <button type="button" className="secondary-button" disabled={pending} onClick={() => run(() => reviewAction(number, "changes_requested", body), () => setBody(""))}>Ask for changes</button>}
            <button type="button" className="secondary-button" disabled={pending || !body.trim()} onClick={() => run(() => reviewAction(number, "commented", body), () => setBody(""))}>Comment</button>
          </div>
        </div>
      )}
      <div className="merge-box">
        <h2>Merge into the published version</h2>
        {readiness.allowed ? <p>Ready to merge.</p> : <ul>{readiness.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        {conflicting && <p>Update the branch to bring in the published version. If the same lines changed in both, edit the page or model on this branch so it reads correctly with both changes, or resolve it in a clone.</p>}
        <div>
          {canMerge && <button type="button" className="primary-button" disabled={pending || !readiness.allowed} onClick={() => { if (window.confirm("Merge this change into the published wiki and model?")) run(() => mergeAction(number)); }}>Squash and merge</button>}
          {canUpdate && <button type="button" className="secondary-button" disabled={pending} onClick={() => run(() => updateBranchAction(number))}>Update branch</button>}
          {canClose && <button type="button" className="text-button" disabled={pending} onClick={() => { if (window.confirm("Close without merging? The branch is kept.")) run(() => closeChangeRequestAction(number)); }}>Close</button>}
        </div>
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
    </section>
  );
}
