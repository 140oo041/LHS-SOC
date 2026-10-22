"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createBranchAction } from "@/app/(workspace)/wiki/actions";

/**
 * Which version of the wiki is on screen, and the way to another one.
 *
 * The default branch is the published record. Every other branch is a
 * draft, so the bar says so plainly whenever one is showing.
 */
export function BranchBar({
  branches,
  branch,
  sha,
  defaultBranch,
  canEdit,
  editingAvailable,
  openRequest,
}: {
  branches: string[];
  branch: string;
  sha: string | null;
  defaultBranch: string;
  canEdit: boolean;
  editingAvailable: boolean;
  /** The change request already open for this branch, if any. */
  openRequest: number | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [creating, setCreating] = useState(false);
  const [topic, setTopic] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const go = (next: string) => router.push(next === defaultBranch ? pathname : `${pathname}?branch=${encodeURIComponent(next)}`);

  function create(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      const result = await createBranchAction(topic, branch);
      if (!result.ok) setError(result.error);
      else {
        setCreating(false);
        setTopic("");
        go(result.branch);
      }
    });
  }

  const draft = branch !== defaultBranch;
  const options = branches.includes(branch) ? branches : [branch, ...branches];

  return (
    <div className={`wiki-branch-bar${draft || sha ? " draft" : ""}`}>
      <label>
        <span>Version</span>
        <select value={branch} onChange={(event) => go(event.target.value)} aria-label="Branch">
          {options.map((name) => (
            <option key={name} value={name}>{name === defaultBranch ? `${name} (published)` : name}</option>
          ))}
        </select>
      </label>
      <p className="wiki-branch-state">
        {sha ? <>Viewing commit <code>{sha.slice(0, 7)}</code> of <strong>{branch}</strong>. <Link href={pathname + (draft ? `?branch=${encodeURIComponent(branch)}` : "")}>Back to latest</Link></>
          : draft ? <>Draft branch. Not published until a change request is approved and merged.</>
          : <>The published wiki and architecture model. Changes arrive here only through approved change requests.</>}
      </p>
      <nav aria-label="Wiki versions">
        <Link href="/wiki/changes">Change requests</Link>
        <Link href={`/wiki/commits${draft ? `?branch=${encodeURIComponent(branch)}` : ""}`}>History</Link>
        {draft && !sha && (openRequest
          ? <Link href={`/wiki/changes/${openRequest}`}>Change request #{openRequest}</Link>
          : canEdit && <Link href={`/wiki/changes/new?branch=${encodeURIComponent(branch)}`}>Propose these changes</Link>)}
        {canEdit && editingAvailable && !sha && <button type="button" onClick={() => setCreating(!creating)} aria-expanded={creating}>New branch</button>}
      </nav>
      {creating && (
        <form className="wiki-branch-create" onSubmit={create}>
          <label>
            <span>Branch from {branch}</span>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} placeholder="What is this change about?" required maxLength={60} autoFocus />
          </label>
          <button type="submit" disabled={pending}>{pending ? "Creating…" : "Create"}</button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
