import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { currentActor } from "@/lib/authz";
import { aiIntegrationEnabled } from "@/lib/features";
import { listWikiPages } from "@/lib/wiki";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { WikiBranchContext } from "./branch-context";

export const metadata: Metadata = { title: "Wiki" };

export default async function WikiIndexPage({ searchParams }: { searchParams: WikiSearchParams }) {
  const view = await wikiView(await currentActor(), searchParams);
  const pages = await listWikiPages(view.ref);
  const link = (path: string) => (view.sha ? `${path}?ref=${view.sha}` : wikiHref(path, view.branch, view.defaultBranch));
  return (
    <div className="library-page">
      <header className="library-heading">
        <div>
          <h1>The design record</h1>
          <p>Read the editable specification beside the architecture it describes. Every explanation can be traced back to a repository source.</p>
        </div>
        <div className="library-actions">
          {view.canEdit && view.editingAvailable && !view.onDefault && !view.sha && (
            <Link className="secondary-button" href={link("/wiki/new")}><Icon name="source" />New page</Link>
          )}
          {aiIntegrationEnabled() && (
            <Link className="primary-button" href="/copilot"><Icon name="copilot" />Ask across the wiki</Link>
          )}
        </div>
      </header>
      <WikiBranchContext view={view} />
      <div className="source-register" role="list">
        {pages.map((page) => (
          <Link href={link(`/wiki/${page.slug}`)} className="source-row" key={page.slug} role="listitem">
            <span className="source-index">{String(page.relatedBlocks.length).padStart(2, "0")}</span>
            <div>
              <h2>{page.title}</h2>
              <p>{page.summary}</p>
            </div>
            <div className="source-meta">
              <span>{page.updatedLabel}</span>
              <code>{page.relativePath}</code>
            </div>
            <Icon name="arrow" />
          </Link>
        ))}
        {!pages.length && <p className="storage-notice">This version of the wiki has no pages{view.onDefault ? "" : `, or the branch ${view.branch} does not exist`}.</p>}
      </div>
    </div>
  );
}
