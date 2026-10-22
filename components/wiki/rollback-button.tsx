"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { rollbackAction } from "@/app/(workspace)/wiki/actions";

/**
 * Roll the wiki and model back to one commit. On a draft branch the rollback
 * is a commit on that branch; from the published branch it becomes a branch
 * of its own, ready to propose, because the published version only changes
 * through review.
 */
export function RollbackButton({ sha, branch, defaultBranch }: { sha: string; branch: string; defaultBranch: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const onDraft = branch !== defaultBranch;

  if (!confirming) {
    return (
      <button type="button" className="rollback-button" onClick={() => setConfirming(true)}>
        Roll back to here
      </button>
    );
  }
  return (
    <span className="rollback-confirm" role="group" aria-label={`Roll back to ${sha.slice(0, 7)}`}>
      <span>
        {onDraft
          ? <>Commit the wiki and model as they were at <code>{sha.slice(0, 7)}</code> onto <strong>{branch}</strong>?</>
          : <>Put the wiki and model as they were at <code>{sha.slice(0, 7)}</code> on a new branch, ready to propose?</>}
      </span>
      <button
        type="button"
        className="model-edit-primary"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError("");
            const result = await rollbackAction({ sha, branch: onDraft ? branch : null });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            if (result.created) {
              router.push(`/wiki/changes/new?branch=${encodeURIComponent(result.branch)}&title=${encodeURIComponent(result.title)}`);
            } else {
              setConfirming(false);
              router.refresh();
            }
          })
        }
      >
        {pending ? "Rolling back…" : "Roll back"}
      </button>
      <button type="button" onClick={() => setConfirming(false)} disabled={pending}>Cancel</button>
      {error && <span role="alert" className="model-edit-error">{error}</span>}
    </span>
  );
}
