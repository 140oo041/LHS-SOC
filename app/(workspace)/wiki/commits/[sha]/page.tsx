import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentActor } from "@/lib/authz";
import { readCommit, readComparison } from "@/lib/content";
import { isCommitSha } from "@/lib/content/branch-name";
import { modelAtCommit } from "@/lib/model/at";
import { diffModels } from "@/lib/model/diff";
import { MODEL_PATH } from "@/lib/model/load";
import { inRollbackScope } from "@/lib/rollback";
import { wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { ModelChanges } from "@/components/architecture/model-changes";
import { DiffView } from "@/components/wiki/diff-view";
import { RollbackButton } from "@/components/wiki/rollback-button";

type Props = { params: Promise<{ sha: string }>; searchParams: WikiSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `Commit ${(await params).sha.slice(0, 7)}` };
}

/** One commit: what it changed, and the way back to it. */
export default async function CommitPage({ params, searchParams }: Props) {
  const view = await wikiView(await currentActor(), searchParams);
  const { sha } = await params;
  if (!view.canBrowseBranches || !isCommitSha(sha)) notFound();
  const commit = await readCommit(sha);
  if (!commit) notFound();

  const [subject, ...rest] = commit.message.split("\n");
  const body = rest.join("\n").replace(/^(Co-authored-by|Atlas-User):.*$/gm, "").trim();
  const parent = commit.parents[0];
  const comparison = parent ? await readComparison(parent, sha).catch(() => null) : null;
  const files = comparison?.files ?? [];
  const atlasFiles = files.filter((file) => inRollbackScope(file.path));
  const otherFiles = files.length - atlasFiles.length;

  let model = null;
  if (parent && files.some((file) => file.path === MODEL_PATH)) {
    const [before, after] = await Promise.all([modelAtCommit(parent).catch(() => null), modelAtCommit(sha).catch(() => null)]);
    if (before && after) {
      model = {
        diff: diffModels(before.model, after.model),
        names: Object.fromEntries([...before.model.blocks, ...after.model.blocks].map((block) => [block.id, block.name])),
      };
    }
  }

  return (
    <div className="wiki-edit-page commit-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb">
        <Link href="/wiki">Wiki</Link><span>/</span><Link href="/wiki/commits">History</Link><span>/</span><span>{sha.slice(0, 7)}</span>
      </nav>
      <header>
        <h1>{subject}</h1>
        <p>
          {commit.atlasUser ?? commit.authorName} · <time dateTime={commit.date}>{new Date(commit.date).toLocaleString()}</time> · <code>{sha}</code>
        </p>
        <p className="commit-links">
          {commit.parents.map((id) => (
            <Link key={id} href={`/wiki/commits/${id}`}>Parent <code>{id.slice(0, 7)}</code></Link>
          ))}
          <Link href={`/wiki?ref=${sha}`}>Browse the wiki at this commit</Link>
          <Link href={`/architecture?ref=${sha}`}>Open the canvas at this commit</Link>
        </p>
        {view.canEdit && view.editingAvailable && <RollbackButton sha={sha} branch={view.branch} defaultBranch={view.defaultBranch} />}
      </header>
      {body && <pre className="commit-body">{body}</pre>}

      {model && <ModelChanges diff={model.diff} branch={{ ref: sha }} names={model.names} />}

      <section>
        <h2 className="section-title">
          Changes {otherFiles > 0 && <small>· {otherFiles} file(s) outside the wiki and model, which a rollback leaves alone</small>}
        </h2>
        {parent ? <DiffView files={files} /> : <p className="diff-empty">The first commit: everything started here.</p>}
      </section>
    </div>
  );
}
