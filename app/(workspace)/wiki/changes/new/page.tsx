import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { currentActor } from "@/lib/authz";
import { compareWithBase, openChangeRequestFor } from "@/lib/change-requests/service";
import { isAtlasBranch } from "@/lib/content/branch-name";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { DiffView } from "@/components/wiki/diff-view";
import { ProposeForm } from "@/components/wiki/review-panel";

export const metadata: Metadata = { title: "Propose changes" };

export default async function NewChangeRequestPage({ searchParams }: { searchParams: WikiSearchParams }) {
  const view = await wikiView(await currentActor(), searchParams);
  const suggested = (await searchParams).title;
  if (!view.canEdit || !isAtlasBranch(view.branch)) notFound();
  const existing = await openChangeRequestFor(view.branch);
  if (existing) redirect(`/wiki/changes/${existing.number}`);
  const comparison = await compareWithBase(view.branch);
  return (
    <div className="wiki-edit-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb"><Link href={wikiHref("/wiki", view.branch, view.defaultBranch)}>Wiki</Link><span>/</span><Link href="/wiki/changes">Change requests</Link><span>/</span><span>New</span></nav>
      <header><h1>Propose changes</h1><p>From <strong>{view.branch}</strong> into the published version ({view.defaultBranch}).</p></header>
      {comparison?.aheadBy ? (
        <>
          <ProposeForm branch={view.branch} initialTitle={typeof suggested === "string" ? suggested.slice(0, 120) : ""} />
          <h2 className="section-title">What would change</h2>
          <DiffView files={comparison.files} />
        </>
      ) : (
        <p className="storage-notice">This branch has no changes yet. Edit a page on it first.</p>
      )}
    </div>
  );
}
