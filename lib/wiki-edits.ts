import { contentStore, expireBranch, expireBranchList, readBlob, readFiles } from "@/lib/content";
import { branchNameFromTopic, isAtlasBranch, isCommitSha } from "@/lib/content/branch-name";
import { canEdit, type Actor } from "@/lib/domain";
import { recordAudit } from "@/lib/roles";
import { isWikiSlug, slugToPath, splitFrontMatter } from "@/lib/wiki";

/**
 * Changing the wiki from Atlas.
 *
 * Every change is a commit on an `atlas/` branch. Nothing here writes to the
 * default branch: that only changes by merging an approved change request
 * (lib/change-requests), for administrators too, so the published wiki always
 * has a review behind it.
 */

export const MAX_PAGE_BYTES = 512 * 1024;

export class WikiEditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

export function assertEditor(actor: Actor) {
  if (!canEdit(actor.role)) throw new WikiEditError("Editing the wiki needs the editor role", 403);
}

export async function assertWritableBranch(branch: string) {
  const store = await contentStore();
  if (branch === store.defaultBranch) {
    throw new WikiEditError(`${store.defaultBranch} only changes through an approved change request. Edit on a branch.`, 409);
  }
  if (!isAtlasBranch(branch)) throw new WikiEditError("Atlas only edits branches it created (atlas/…)", 409);
}

/** One line, no angle brackets: safe inside a Co-authored-by trailer. */
const trailerName = (name: string) => name.replace(/[\r\n<>]/g, " ").trim() || "Atlas user";

/**
 * The commit message Atlas writes. The App is the committer; the person is
 * credited with a Co-authored-by trailer, which GitHub shows on the commit,
 * and named in Atlas-User, which Atlas reads back for history.
 */
export function commitMessage(actor: Actor, summary: string) {
  const subject = summary.replace(/\s+/g, " ").trim().slice(0, 120) || "Update wiki";
  return `${subject}\n\nCo-authored-by: ${trailerName(actor.name)} <${actor.email}>\nAtlas-User: ${actor.email}`;
}

export async function createBranch(actor: Actor, topic: string, from?: string) {
  assertEditor(actor);
  const name = branchNameFromTopic(topic);
  if (!isAtlasBranch(name)) throw new WikiEditError("Name the branch with letters or numbers", 400);
  const store = await contentStore();
  const source = from ?? store.defaultBranch;
  const sha = isCommitSha(source) ? source : await store.resolveHead(source);
  if (!sha) throw new WikiEditError(`${source} does not exist`, 404);
  await store.createBranch(name, sha);
  await expireBranchList();
  await recordAudit(actor, "wiki.branch.create", name, { from: source });
  return name;
}

export type SaveInput = {
  branch: string;
  slug: string;
  source: string;
  /** The blob the editor loaded, or null when creating the page. */
  expectedBlobSha: string | null;
  message: string;
};

export async function savePage(actor: Actor, input: SaveInput) {
  assertEditor(actor);
  await assertWritableBranch(input.branch);
  if (!isWikiSlug(input.slug)) throw new WikiEditError("Page names use lowercase letters, numbers, and hyphens", 400);

  // Windows editors send CRLF; storing it would show every line as changed.
  const source = input.source.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(source) > MAX_PAGE_BYTES) throw new WikiEditError("Pages must be 512 KB or smaller", 400);
  if (!source.trim()) throw new WikiEditError("A page cannot be empty", 400);
  const frontMatter = splitFrontMatter(source);
  if (frontMatter.error) throw new WikiEditError(`Front matter: ${frontMatter.error}`, 400);

  const store = await contentStore();
  const result = await store.writeFile({
    branch: input.branch,
    path: slugToPath(input.slug),
    content: source,
    expectedBlobSha: input.expectedBlobSha,
    message: commitMessage(actor, input.message || `Update ${input.slug}`),
  });
  await expireBranch(input.branch);
  return result;
}

/** The page as it was at one commit, or null if it did not exist then. */
export async function readPageAt(slug: string, commitSha: string) {
  if (!isWikiSlug(slug) || !isCommitSha(commitSha)) return null;
  const file = (await readFiles(commitSha)).find((entry) => entry.path === slugToPath(slug));
  return file ? readBlob(file.blobSha) : null;
}

/** Restoring is an ordinary new commit whose content is an old version. */
export async function restoreVersion(actor: Actor, input: { branch: string; slug: string; fromSha: string; expectedBlobSha: string | null }) {
  const source = await readPageAt(input.slug, input.fromSha);
  if (source === null) throw new WikiEditError("That version of the page does not exist", 404);
  return savePage(actor, {
    branch: input.branch,
    slug: input.slug,
    source,
    expectedBlobSha: input.expectedBlobSha,
    message: `Restore ${slugToPath(input.slug)} to ${input.fromSha.slice(0, 7)}`,
  });
}

export async function deleteBranch(actor: Actor, branch: string) {
  assertEditor(actor);
  await assertWritableBranch(branch);
  const store = await contentStore();
  const open = (await store.listOpenPullRequests()).find((pull) => pull.headRef === branch);
  if (open) throw new WikiEditError("Close this branch's change request before deleting it", 409);
  await store.deleteBranch(branch);
  await expireBranchList();
  await expireBranch(branch);
  await recordAudit(actor, "wiki.branch.delete", branch);
}
