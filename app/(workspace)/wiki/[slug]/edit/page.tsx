import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentActor } from "@/lib/authz";
import { isAtlasBranch } from "@/lib/content/branch-name";
import { getWikiPage } from "@/lib/wiki";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { PageEditor, StartDraft } from "@/components/wiki/page-editor";

export const metadata: Metadata = { title: "Edit page" };

export default async function EditWikiPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: WikiSearchParams }) {
  const { slug } = await params;
  const view = await wikiView(await currentActor(), searchParams);
  const page = await getWikiPage(slug, { branch: view.branch });
  if (!page) notFound();

  let body: React.ReactNode;
  if (!view.canEdit) body = <p className="storage-notice">Editing the wiki needs the editor role.</p>;
  else if (!view.editingAvailable) body = <p className="storage-notice">This deployment is not connected to the wiki&apos;s GitHub repository, so the wiki is read-only here.</p>;
  else if (!isAtlasBranch(view.branch)) body = <StartDraft slug={slug} from={view.branch} title={page.title} />;
  else body = <PageEditor slug={slug} branch={view.branch} initialSource={page.source} initialBlobSha={page.blobSha} />;

  return (
    <div className="wiki-edit-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb">
        <Link href={wikiHref("/wiki", view.branch, view.defaultBranch)}>Wiki</Link><span>/</span>
        <Link href={wikiHref(`/wiki/${slug}`, view.branch, view.defaultBranch)}>{page.title}</Link><span>/</span><span>Edit</span>
      </nav>
      <header><h1>Edit {page.title}</h1><p><code>{page.relativePath}</code> on <strong>{view.branch}</strong></p></header>
      {body}
    </div>
  );
}
