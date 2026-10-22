import { readBranches } from "@/lib/content";
import { openChangeRequestFor } from "@/lib/change-requests/service";
import type { WikiView } from "@/lib/wiki-view";
import { BranchBar } from "@/components/wiki/branch-bar";

/** The branch bar, with the data it needs, for any wiki screen. */
export async function WikiBranchContext({ view }: { view: WikiView }) {
  if (!view.canBrowseBranches) return null;
  const [branches, request] = await Promise.all([
    readBranches(),
    view.onDefault ? Promise.resolve(null) : openChangeRequestFor(view.branch).catch(() => null),
  ]);
  return (
    <BranchBar
      branches={branches.map((branch) => branch.name).sort((a, b) => (a === view.defaultBranch ? -1 : b === view.defaultBranch ? 1 : a.localeCompare(b)))}
      branch={view.branch}
      sha={view.sha}
      defaultBranch={view.defaultBranch}
      canEdit={view.canEdit}
      editingAvailable={view.editingAvailable}
      openRequest={request?.number ?? null}
    />
  );
}
