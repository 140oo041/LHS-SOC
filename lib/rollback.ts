import { contentStore, expireBranch, readCommit, readFiles, WIKI_ROOT } from "@/lib/content";
import { isAtlasBranch, isCommitSha } from "@/lib/content/branch-name";
import { ContentConflictError, type TreeChange } from "@/lib/content/types";
import type { Actor } from "@/lib/domain";
import { modelAtCommit } from "@/lib/model/at";
import { MODEL_PATH, ModelInvalidError } from "@/lib/model/load";
import { recordAudit } from "@/lib/roles";
import { assertEditor, assertWritableBranch, commitMessage, createBranch, WikiEditError } from "@/lib/wiki-edits";

/**
 * Rolling Atlas content back to how it was at any commit.
 *
 * A rollback never rewrites history. It is a new commit whose wiki pages and
 * architecture model are those of the chosen commit, so the commits after it
 * stay in the graph and the rollback can itself be rolled back.
 *
 * Only what Atlas manages comes back: `docs/` and the model. The repository
 * also holds the application's code, and a wiki button must never revert
 * that.
 *
 * The published branch is not rolled back directly. As with any change, the
 * rollback goes onto a branch of its own and is published by an approved
 * change request.
 */

export function inRollbackScope(path: string) {
  return path.startsWith(`${WIKI_ROOT}/`) || path === MODEL_PATH;
}

async function scopedFiles(commitSha: string) {
  const [docs, architecture] = await Promise.all([readFiles(commitSha, WIKI_ROOT), readFiles(commitSha, "architecture")]);
  return new Map([...docs, ...architecture].filter((file) => inRollbackScope(file.path)).map((file) => [file.path, file.blobSha]));
}

/** What committing `target`'s content on top of `head` would change. */
export async function rollbackChanges(targetSha: string, headSha: string): Promise<TreeChange[]> {
  const [target, head] = await Promise.all([scopedFiles(targetSha), scopedFiles(headSha)]);
  const changes: TreeChange[] = [];
  for (const [path, blobSha] of target) if (head.get(path) !== blobSha) changes.push({ path, blobSha });
  for (const path of head.keys()) if (!target.has(path)) changes.push({ path, blobSha: null });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

const subjectOf = (message: string) => message.split("\n")[0].slice(0, 80);

export async function rollBack(actor: Actor, input: { sha: string; branch?: string | null }) {
  assertEditor(actor);
  if (!isCommitSha(input.sha)) throw new WikiEditError("That is not a commit", 400);
  const target = await readCommit(input.sha);
  if (!target) throw new WikiEditError("That commit does not exist", 404);
  try {
    await modelAtCommit(input.sha);
  } catch (error) {
    if (error instanceof ModelInvalidError) throw new WikiEditError("The architecture model at that commit is not valid, so Atlas cannot bring it back", 400);
    throw error;
  }

  const store = await contentStore();
  const short = input.sha.slice(0, 7);
  const onDraft = input.branch && input.branch !== store.defaultBranch && isAtlasBranch(input.branch);
  if (onDraft) await assertWritableBranch(input.branch!);

  // Compare first, so nothing is created when there is nothing to roll back.
  const base = onDraft ? input.branch! : store.defaultBranch;
  const baseHead = await store.resolveHead(base);
  if (!baseHead) throw new WikiEditError(`${base} does not exist`, 404);
  if (!(await rollbackChanges(input.sha, baseHead)).length) {
    throw new WikiEditError(`The wiki and model on ${base} already match ${short}`, 409);
  }

  let branch = input.branch!;
  if (!onDraft) {
    branch = "";
    for (let n = 1; n < 10 && !branch; n += 1) {
      try {
        branch = await createBranch(actor, `rollback ${short}${n > 1 ? ` ${n}` : ""}`, baseHead);
      } catch (error) {
        if (!(error instanceof ContentConflictError)) throw error;
      }
    }
    if (!branch) throw new WikiEditError("Could not find a free branch name for the rollback", 409);
  }

  const head = (await store.resolveHead(branch))!;
  const changes = await rollbackChanges(input.sha, head);
  const result = await store.commitTree({
    branch,
    expectedHeadSha: head,
    changes,
    message: commitMessage(actor, `Roll back to ${short}: ${subjectOf(target.message)}`),
  });
  await expireBranch(branch);
  await recordAudit(actor, "wiki.rollback", branch, { to: input.sha, files: changes.length });
  return { branch, commitSha: result.commitSha, created: !onDraft, files: changes.length, title: `Roll back to ${short}: ${subjectOf(target.message)}` };
}
