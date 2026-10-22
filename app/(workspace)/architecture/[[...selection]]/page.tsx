import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Explorer, type ModelEditContext } from "@/components/architecture/explorer";
import { lensFromParams } from "@/components/architecture/lens";
import { currentActor } from "@/lib/authz";
import { branchModelChanges, modelAt, publishedModel, snapshotWithChanges } from "@/lib/model/at";
import { wikiView, type WikiSearchParams } from "@/lib/wiki-view";
import { WikiBranchContext } from "../../wiki/branch-context";

type Params = { selection?: string[] };

function selectedIdFrom(selection: string[] | undefined): string | null {
  if (!selection || selection.length === 0) return null;
  return decodeURIComponent(selection[0]);
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const selectedId = selectedIdFrom((await params).selection);
  if (!selectedId) return { title: "Architecture" };
  const block = (await publishedModel()).snapshot.blocks[selectedId];
  return { title: block ? `${block.name} · Architecture` : "Architecture" };
}

/**
 * The explorer route.
 *
 * An optional catch-all so /architecture and /architecture/<blockId> are the
 * same surface: a deep link selects a block without remounting the canvas or
 * sending the visitor to a different page.
 *
 * The model is read at a version, like the wiki: `?branch=` shows a draft
 * branch with what it changes marked on the canvas, and `?ref=` one exact
 * commit. Editors change the model here, on a branch.
 */
export default async function ArchitecturePage({ params, searchParams }: { params: Promise<Params>; searchParams: WikiSearchParams }) {
  const actor = await currentActor();
  const view = await wikiView(actor, searchParams);
  const version = await modelAt(view.ref);
  if (!version) notFound();

  const changes = view.onDefault || view.sha ? null : await branchModelChanges(view.branch).catch(() => null);
  const snapshot = changes ? snapshotWithChanges(changes) : version.snapshot;

  // On a branch, a block can disappear while it is selected (it was just
  // removed); the canvas then opens without a selection rather than a 404.
  let selectedId = selectedIdFrom((await params).selection);
  if (selectedId && !snapshot.blocks[selectedId]) {
    if (view.onDefault && !view.sha) notFound();
    selectedId = null;
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") search.set(key, value);
    else if (Array.isArray(value) && value[0]) search.set(key, value[0]);
  }

  const versionQuery = new URLSearchParams();
  if (!view.onDefault || view.sha) versionQuery.set("branch", view.branch);
  if (view.sha) versionQuery.set("ref", view.sha);

  const editing: ModelEditContext | null =
    view.canEdit && view.editingAvailable && !view.sha
      ? { branch: view.branch, blobSha: version.blobSha, onDefault: view.onDefault }
      : null;

  return (
    <div className="architecture-page">
      <WikiBranchContext view={view} />
      <Explorer
        snapshot={snapshot}
        initialSelectedId={selectedId}
        initialLens={lensFromParams(search)}
        versionQuery={versionQuery.toString()}
        editing={editing}
      />
    </div>
  );
}
