import { contentStore, expireBranch, readBlob } from "@/lib/content";
import { ContentConflictError } from "@/lib/content/types";
import type { Actor } from "@/lib/domain";
import { modelAtCommit } from "@/lib/model/at";
import { applyModelEdit, type ModelEdit } from "@/lib/model/edit";
import { MODEL_PATH, ModelInvalidError, parseModel } from "@/lib/model/load";
import { assertEditor, assertWritableBranch, commitMessage, WikiEditError } from "@/lib/wiki-edits";

/**
 * Changing the architecture model from the canvas.
 *
 * The same rules as the wiki: an editor commits to an `atlas/` branch, never
 * to the default branch, and the change is published by an approved change
 * request. One branch can carry wiki pages and model edits together, so a
 * design change and its write-up are reviewed as one.
 */

export type ModelEditInput = {
  branch: string;
  /** The model blob the canvas was showing; the edit is refused if it moved. */
  expectedBlobSha: string;
  edit: ModelEdit;
};

async function currentModel(actor: Actor, branch: string, expectedBlobSha: string) {
  assertEditor(actor);
  await assertWritableBranch(branch);
  const store = await contentStore();
  const head = await store.resolveHead(branch);
  if (!head) throw new WikiEditError(`${branch} does not exist`, 404);
  const current = await modelAtCommit(head);
  if (!current) throw new WikiEditError(`${MODEL_PATH} is missing on ${branch}`, 404);
  if (current.blobSha !== expectedBlobSha) {
    throw new ContentConflictError(`The model changed on ${branch} since you opened it. Reload to see the latest version.`);
  }
  return { store, current };
}

export async function editModel(actor: Actor, input: ModelEditInput) {
  const { store, current } = await currentModel(actor, input.branch, input.expectedBlobSha);
  const { text, summary } = applyModelEdit(current.text, input.edit);
  const result = await store.writeFile({
    branch: input.branch,
    path: MODEL_PATH,
    content: text,
    expectedBlobSha: current.blobSha,
    message: commitMessage(actor, summary),
  });
  await expireBranch(input.branch);
  return { ...result, summary };
}

/**
 * Puts the model back to an earlier version of itself, as a new commit:
 * what Undo on the canvas does. The earlier version is checked again, so
 * only a valid model can come back.
 */
export async function restoreModel(actor: Actor, input: { branch: string; expectedBlobSha: string; blobSha: string }) {
  const { store, current } = await currentModel(actor, input.branch, input.expectedBlobSha);
  if (input.blobSha === current.blobSha) throw new WikiEditError("That is already the current version", 400);
  const text = await readBlob(input.blobSha).catch(() => null);
  if (text === null) throw new WikiEditError("That version of the model does not exist", 404);
  try {
    parseModel(text);
  } catch (error) {
    if (error instanceof ModelInvalidError) throw new WikiEditError("That version of the model is not valid", 400);
    throw error;
  }
  const result = await store.writeFile({
    branch: input.branch,
    path: MODEL_PATH,
    content: text,
    expectedBlobSha: current.blobSha,
    message: commitMessage(actor, "Undo the last model edit"),
  });
  await expireBranch(input.branch);
  return { ...result, summary: "Undid the last edit" };
}
