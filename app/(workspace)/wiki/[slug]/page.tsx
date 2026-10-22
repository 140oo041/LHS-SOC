import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@/components/icons";
import { currentActor } from "@/lib/authz";
import { isAtlasBranch } from "@/lib/content/branch-name";
import { aiIntegrationEnabled } from "@/lib/features";
import { getWikiPage } from "@/lib/wiki";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { WikiBranchContext } from "../branch-context";

type Props = { params: Promise<{ slug: string }>; searchParams: WikiSearchParams };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const view = await wikiView(await currentActor(), searchParams);
  const page = await getWikiPage((await params).slug, view.ref);
  return { title: page?.title ?? "Wiki" };
}

export default async function WikiArticlePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const view = await wikiView(await currentActor(), searchParams);
  const page = await getWikiPage(slug, view.ref);
  if (!page) notFound();
  const askParams = new URLSearchParams({ sourcePath: page.relativePath, sourceTitle: page.title });
  const href = (path: string) => wikiHref(path, view.branch, view.defaultBranch);
  const editable = view.canEdit && view.editingAvailable && !view.sha;
  return (
    <div className="reading-workbench">
      <article className="wiki-article">
        <nav className="article-breadcrumbs" aria-label="Breadcrumb"><Link href={href("/wiki")}>Wiki</Link><span>/</span><span>{page.title}</span></nav>
        <WikiBranchContext view={view} />
        <header>
          <h1>{page.title}</h1>
          <p>{page.summary}</p>
        </header>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.content.replace(/^#\s+.+$/m, "")}</ReactMarkdown>
      </article>
      <aside className="reading-rail">
        <div className="source-stamp"><Icon name="source" /><span><strong>{view.onDefault ? "Published source" : "Draft source"}</strong><code>{page.relativePath} @ {page.commitSha.slice(0, 7)}</code></span></div>
        {editable && (
          <Link className="primary-field-action" href={href(`/wiki/${slug}/edit`)}>
            <Icon name="source" />
            <span>
              <strong>{isAtlasBranch(view.branch) ? "Edit this page" : "Propose an edit"}</strong>
              <small>{isAtlasBranch(view.branch) ? `Commits to ${view.branch}` : "Starts a draft branch"}</small>
            </span>
            <Icon name="arrow" />
          </Link>
        )}
        {view.canBrowseBranches && (
          <Link className="rail-link" href={href(`/wiki/${slug}/history`)}><Icon name="calendar" /><span>History of this page</span></Link>
        )}
        {aiIntegrationEnabled() && (
          <Link className="primary-field-action" href={`/copilot?${askParams}`}>
            <Icon name="copilot" />
            <span><strong>Ask about this page</strong><small>Answers stay grounded here</small></span>
            <Icon name="arrow" />
          </Link>
        )}
        <section>
          <h2>Related architecture</h2>
          {page.relatedBlocks.length ? page.relatedBlocks.map((block) => (
            <Link href={`/architecture?selected=${block}`} key={block}><span>{block}</span><Icon name="arrow" /></Link>
          )) : <p>No block links recorded yet.</p>}
        </section>
        <p className="field-note">Change the Markdown and architecture model in the same pull request when a decision affects both.</p>
      </aside>
    </div>
  );
}
