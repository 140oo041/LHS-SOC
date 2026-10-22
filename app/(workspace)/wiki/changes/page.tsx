import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { currentActor } from "@/lib/authz";
import { listChangeRequests, type ChangeRequest } from "@/lib/change-requests/service";
import { wikiView, type WikiSearchParams } from "@/lib/wiki-view";

export const metadata: Metadata = { title: "Change requests" };

function Row({ request }: { request: ChangeRequest }) {
  return (
    <Link className="change-row" href={`/wiki/changes/${request.number}`}>
      <span className={`change-status ${request.status}`}>{request.status}</span>
      <div><strong>{request.title}</strong><span>#{request.number} · <code>{request.branch}</code> · {request.authorEmail ?? request.authorGithubLogin ?? "GitHub"}</span></div>
      <time dateTime={request.updatedAt}>{new Date(request.updatedAt).toLocaleDateString()}</time>
    </Link>
  );
}

export default async function ChangeRequestsPage({ searchParams }: { searchParams: WikiSearchParams }) {
  const view = await wikiView(await currentActor(), searchParams);
  if (!view.canBrowseBranches) notFound();
  const requests = await listChangeRequests();
  const open = requests.filter((request) => request.status === "open");
  const done = requests.filter((request) => request.status !== "open").slice(0, 30);
  return (
    <div className="library-page">
      <header className="library-heading">
        <div>
          <h1>Change requests</h1>
          <p>Proposed changes to the published wiki and architecture model. Each needs an approval from an editor or administrator other than its author, and an administrator merges it.</p>
        </div>
      </header>
      <section className="change-list">
        <h2>Open</h2>
        {open.map((request) => <Row key={request.id} request={request} />)}
        {!open.length && <p className="storage-notice">Nothing waiting for review. Edit a page on a draft branch, then propose it from the version bar.</p>}
      </section>
      {done.length > 0 && (
        <section className="change-list">
          <h2>Recently closed</h2>
          {done.map((request) => <Row key={request.id} request={request} />)}
        </section>
      )}
    </div>
  );
}
