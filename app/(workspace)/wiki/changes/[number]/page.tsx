import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { currentActor } from "@/lib/authz";
import { getChangeRequest, mergeReadiness } from "@/lib/change-requests/service";
import { wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { ModelChanges } from "@/components/architecture/model-changes";
import { DiffView } from "@/components/wiki/diff-view";
import { branchModelChanges } from "@/lib/model/at";
import { ReviewPanel } from "@/components/wiki/review-panel";

type Props = { params: Promise<{ number: string }>; searchParams: WikiSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `Change request #${(await params).number}` };
}

const verdictLabel = { approved: "approved", changes_requested: "asked for changes", commented: "commented" } as const;

export default async function ChangeRequestPage({ params, searchParams }: Props) {
  const actor = await currentActor();
  const view = await wikiView(actor, searchParams);
  const number = Number((await params).number);
  if (!view.canBrowseBranches || !actor || !Number.isInteger(number) || number < 1) notFound();
  const detail = await getChangeRequest(number);
  if (!detail) notFound();
  const { request, reviews, pull, comparison } = detail;
  const readiness = await mergeReadiness(actor, detail);
  const isAuthor = request.authorEmail === actor.email;
  const model = request.status === "open" ? await branchModelChanges(request.branch).catch(() => null) : null;
  const names = model ? Object.fromEntries([...model.base.model.blocks, ...model.head.model.blocks].map((block) => [block.id, block.name])) : {};

  return (
    <div className="wiki-edit-page change-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb"><Link href="/wiki">Wiki</Link><span>/</span><Link href="/wiki/changes">Change requests</Link><span>/</span><span>#{number}</span></nav>
      <header>
        <span className={`change-status ${request.status}`}>{request.status}</span>
        <h1>{request.title}</h1>
        <p>
          <code>{request.branch}</code> into <code>{request.baseBranch}</code> · proposed by {request.authorEmail ?? request.authorGithubLogin ?? "GitHub"}
          {request.status === "open" && <> · <Link href={`/wiki?branch=${encodeURIComponent(request.branch)}`}>Read the branch</Link></>}
          {pull?.htmlUrl && <> · <a href={pull.htmlUrl} target="_blank" rel="noopener">On GitHub</a></>}
        </p>
      </header>
      {request.description && <div className="wiki-article change-description"><ReactMarkdown remarkPlugins={[remarkGfm]}>{request.description}</ReactMarkdown></div>}

      {request.status === "open" && (
        <ReviewPanel
          number={number}
          canReview={view.canEdit && !isAuthor}
          canComment={view.canEdit}
          canMerge={view.canAdmin}
          canClose={isAuthor || view.canAdmin}
          canUpdate={view.canEdit && Boolean(comparison?.behindBy)}
          readiness={readiness}
        />
      )}
      {request.status === "merged" && <p className="storage-notice">Merged by {request.mergedByEmail ?? "GitHub"}{request.mergedAt ? ` on ${new Date(request.mergedAt).toLocaleString()}` : ""}{request.mergeCommitSha ? <> as <code>{request.mergeCommitSha.slice(0, 7)}</code></> : null}.</p>}
      {request.status === "closed" && <p className="storage-notice">Closed without merging.</p>}

      <section className="review-log">
        <h2 className="section-title">Reviews</h2>
        {reviews.length ? (
          <ol>
            {reviews.map((review) => (
              <li key={review.id} className={review.dismissed ? "dismissed" : undefined}>
                <strong>{review.reviewerEmail}</strong> {verdictLabel[review.verdict]} on <code>{review.headSha.slice(0, 7)}</code>
                {review.dismissed && <em> · dismissed by a later commit</em>}
                <time dateTime={review.createdAt}> · {new Date(review.createdAt).toLocaleString()}</time>
                {review.body && <p>{review.body}</p>}
              </li>
            ))}
          </ol>
        ) : <p className="diff-empty">No reviews yet.</p>}
      </section>

      {model && <ModelChanges diff={model.diff} branch={request.branch} names={names} />}

      {comparison && (
        <section>
          <h2 className="section-title">Changes {comparison.behindBy > 0 && <small>· {comparison.behindBy} commit(s) behind {request.baseBranch}</small>}</h2>
          <DiffView files={comparison.files} />
        </section>
      )}
    </div>
  );
}
