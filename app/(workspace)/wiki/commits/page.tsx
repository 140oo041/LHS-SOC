import type { Metadata } from "next";
import Link from "next/link";
import { currentActor } from "@/lib/authz";
import { readBranches, readCommits, readHead } from "@/lib/content";
import { layoutGraph } from "@/lib/content/commit-graph";
import { wikiHref, wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { CommitGraphView } from "@/components/wiki/commit-graph";
import { WikiBranchContext } from "../branch-context";

export const metadata: Metadata = { title: "History" };

/** How many commits back each branch is followed. */
const DEPTH = 60;
/** Branches drawn at most; the published one and Atlas's own come first. */
const MAX_BRANCHES = 20;

export default async function CommitsPage({ searchParams }: { searchParams: WikiSearchParams }) {
  const view = await wikiView(await currentActor(), searchParams);
  const branches = view.canBrowseBranches
    ? (await readBranches()).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).slice(0, MAX_BRANCHES)
    : [{ name: view.defaultBranch, headSha: (await readHead(view.defaultBranch)) ?? "" }].filter((branch) => branch.headSha);

  function rank(name: string) {
    return name === view.defaultBranch ? 0 : name.startsWith("atlas/") ? 1 : 2;
  }

  const commits = branches.length ? await readCommits(branches.map((branch) => branch.headSha), DEPTH) : [];
  const graph = layoutGraph(commits);
  const labels: Record<string, string[]> = {};
  for (const branch of branches) (labels[branch.headSha] ??= []).push(branch.name);

  return (
    <div className="wiki-edit-page commits-page">
      <nav className="article-breadcrumbs" aria-label="Breadcrumb">
        <Link href={wikiHref("/wiki", view.branch, view.defaultBranch)}>Wiki</Link><span>/</span><span>History</span>
      </nav>
      <WikiBranchContext view={view} />
      <header>
        <h1>History</h1>
        <p>
          Every commit to {view.canBrowseBranches ? "every branch" : "the published version"}, newest first, whether it was made in Atlas or pushed from a clone.
          {view.canEdit && view.editingAvailable && (
            <>
              {" "}Any of them can be rolled back to. A rollback is a new commit, so nothing is lost and it can be rolled back too.
              {view.onDefault
                ? " From the published version, a rollback goes on a new branch to be proposed and approved."
                : <> On <strong>{view.branch}</strong>, a rollback is committed to that branch.</>}
              {" "}It covers the wiki and the architecture model, never the application&rsquo;s code.
            </>
          )}
        </p>
      </header>
      {graph.rows.length ? (
        <CommitGraphView
          graph={graph}
          labels={labels}
          branch={view.branch}
          defaultBranch={view.defaultBranch}
          canBrowse={view.canBrowseBranches}
          canRollBack={view.canEdit && view.editingAvailable}
        />
      ) : (
        <p className="diff-empty">No commits to show.</p>
      )}
    </div>
  );
}
