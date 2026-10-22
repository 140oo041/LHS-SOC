import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentActor } from "@/lib/authz";
import { readHead, readHistory } from "@/lib/content";
import { isAtlasBranch } from "@/lib/content/branch-name";
import { getWikiPage, slugToPath } from "@/lib/wiki";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { RestoreButton } from "@/components/wiki/restore-button";

export const metadata: Metadata = { title: "Page history" };

export default async function WikiHistoryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: WikiSearchParams }) {
  const { slug } = await params;
  const view = await wikiView(await currentActor(), searchParams);
  if (!view.canBrowseBranches) notFound();
  const [page, head] = await Promise.all([getWikiPage(slug, { branch: view.branch }), readHead(view.branch)]);
  if (!page || !head) notFound();
  const history = await readHistory(view.branch, head, slugToPath(slug));
  const canRestore = view.canEdit && view.editingAvailable && isAtlasBranch(view.branch);

  return (
    <div className="wiki-edit-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb">
        <Link href={wikiHref("/wiki", view.branch, view.defaultBranch)}>Wiki</Link><span>/</span>
        <Link href={wikiHref(`/wiki/${slug}`, view.branch, view.defaultBranch)}>{page.title}</Link><span>/</span><span>History</span>
      </nav>
      <header><h1>History of {page.title}</h1><p><code>{page.relativePath}</code> on <strong>{view.branch}</strong>, newest first.</p></header>
      {!canRestore && view.canEdit && <p className="storage-notice">To restore an old version, open this history on a draft branch. The published wiki only changes through change requests.</p>}
      <ol className="commit-list">
        {history.map((commit, index) => (
          <li key={commit.sha}>
            <div>
              <strong>{commit.message.split("\n")[0]}</strong>
              <span>{commit.atlasUser ?? commit.authorName} · {commit.date ? new Date(commit.date).toLocaleString() : ""} · <code>{commit.sha.slice(0, 7)}</code></span>
            </div>
            <Link href={`/wiki/${slug}?ref=${commit.sha}`}>View</Link>
            {canRestore && index > 0 && <RestoreButton branch={view.branch} slug={slug} fromSha={commit.sha} expectedBlobSha={page.blobSha} />}
          </li>
        ))}
        {!history.length && <li>No recorded changes.</li>}
      </ol>
    </div>
  );
}
