"use server";

import { currentActor } from "@/lib/authz";
import { isContentError } from "@/lib/content/types";
import { ModelEditError } from "@/lib/model/edit";
import { editModel, restoreModel, type ModelEditInput } from "@/lib/model-edits";
import { WikiEditError } from "@/lib/wiki-edits";

export type ModelEditResult = { ok: true; blobSha: string; commitSha: string; summary: string } | { ok: false; error: string };

/**
 * The canvas's one write: apply a structured edit to the model on a branch.
 * Like the wiki's actions, it re-checks who is asking and reports failure as
 * a result the form can show.
 */
export async function modelEditAction(input: ModelEditInput): Promise<ModelEditResult> {
  return run((actor) => editModel(actor, input));
}

/** Undo: commit an earlier version of the model back onto the branch. */
export async function modelRestoreAction(input: { branch: string; expectedBlobSha: string; blobSha: string }): Promise<ModelEditResult> {
  return run((actor) => restoreModel(actor, input));
}

async function run(work: (actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>) => Promise<{ blobSha: string; commitSha: string; summary: string }>): Promise<ModelEditResult> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: "Sign in to change the model." };
  try {
    return { ok: true, ...(await work(actor)) };
  } catch (error) {
    if (error instanceof ModelEditError || error instanceof WikiEditError || isContentError(error)) return { ok: false, error: error.message };
    console.error("Model edit failed", error);
    return { ok: false, error: "Atlas could not change the model. Try again." };
  }
}
