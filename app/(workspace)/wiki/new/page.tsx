import type { Metadata } from "next";
import Link from "next/link";
import { currentActor } from "@/lib/authz";
import { isAtlasBranch } from "@/lib/content/branch-name";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { NewPageForm } from "@/components/wiki/new-page-form";

export const metadata: Metadata = { title: "New page" };

export default async function NewWikiPage({ searchParams }: { searchParams: WikiSearchParams }) {
  const view = await wikiView(await currentActor(), searchParams);
  const ready = view.canEdit && view.editingAvailable && isAtlasBranch(view.branch);
  return (
    <div className="wiki-edit-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb"><Link href={wikiHref("/wiki", view.branch, view.defaultBranch)}>Wiki</Link><span>/</span><span>New page</span></nav>
      <header><h1>New page</h1><p>On <strong>{view.branch}</strong></p></header>
      {ready ? <NewPageForm branch={view.branch} /> : <p className="storage-notice">New pages are added on a draft branch. Switch to one, or create one from the wiki&apos;s version bar.</p>}
    </div>
  );
}
