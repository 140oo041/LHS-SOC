import { isPublicVisitor } from "@/lib/authz";
import { contentStore, wikiEditingAvailable } from "@/lib/content";
import { isCommitSha, isReadableBranchName } from "@/lib/content/branch-name";
import { canAdmin, canEdit, type Actor } from "@/lib/domain";
import type { WikiRef } from "@/lib/wiki";

export type WikiSearchParams = Promise<Record<string, string | string[] | undefined>>;

export type WikiView = {
  ref: WikiRef;
  branch: string;
  /** Set when viewing one exact commit rather than a branch's latest. */
  sha: string | null;
  defaultBranch: string;
  onDefault: boolean;
  /** Public visitors read the published wiki only. */
  canBrowseBranches: boolean;
  canEdit: boolean;
  canAdmin: boolean;
  editingAvailable: boolean;
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * Which version of the wiki this request reads, and what the reader may do.
 *
 * Anonymous visitors are pinned to the default branch: the repository is
 * public, so this is not secrecy, but unreviewed drafts are not the
 * published record and should not look like it.
 */
export async function wikiView(actor: Actor | null, searchParams: WikiSearchParams): Promise<WikiView> {
  const params = await searchParams;
  const store = await contentStore();
  const canBrowseBranches = Boolean(actor) && !isPublicVisitor(actor);
  const requestedBranch = first(params.branch);
  const requestedSha = first(params.ref);
  const branch = canBrowseBranches && requestedBranch && isReadableBranchName(requestedBranch) ? requestedBranch : store.defaultBranch;
  const sha = canBrowseBranches && requestedSha && isCommitSha(requestedSha) ? requestedSha : null;
  const editor = Boolean(actor) && canEdit(actor!.role) && !isPublicVisitor(actor);
  return {
    ref: sha ? { sha } : { branch },
    branch,
    sha,
    defaultBranch: store.defaultBranch,
    onDefault: branch === store.defaultBranch && !sha,
    canBrowseBranches,
    canEdit: editor,
    canAdmin: Boolean(actor) && canAdmin(actor!.role),
    editingAvailable: wikiEditingAvailable(),
  };
}

/** A wiki URL that keeps the branch being viewed. */
export function wikiHref(path: string, branch: string, defaultBranch: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (branch !== defaultBranch) params.set("branch", branch);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
