"use server";

import { currentActor } from "@/lib/authz";
import * as changes from "@/lib/change-requests/service";
import type { ReviewVerdict } from "@/lib/change-requests/policy";
import { ContentConflictError, isContentError } from "@/lib/content/types";
import { getWikiPage } from "@/lib/wiki";
import * as edits from "@/lib/wiki-edits";

/**
 * Server actions behind the wiki's editing and review screens. Each one
 * re-checks who is asking (actions are public endpoints) and returns a
 * result instead of throwing, so the screen can show what went wrong.
 */

export type ActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

async function run<T extends object>(work: (actor: NonNullable<Awaited<ReturnType<typeof currentActor>>>) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: "Sign in to change the wiki." };
  try {
    return { ok: true, ...(await work(actor)) };
  } catch (error) {
    if (error instanceof edits.WikiEditError || error instanceof changes.ChangeRequestError || isContentError(error)) {
      return { ok: false, error: error.message };
    }
    console.error("Wiki action failed", error);
    return { ok: false, error: "Atlas could not complete that. Try again." };
  }
}

export async function createBranchAction(topic: string, from?: string) {
  return run(async (actor) => ({ branch: await edits.createBranch(actor, topic, from) }));
}

export type SaveResult =
  | { ok: true; blobSha: string; commitSha: string }
  | { ok: false; error: string; conflict?: { source: string; blobSha: string } };

export async function savePageAction(input: edits.SaveInput): Promise<SaveResult> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: "Sign in to change the wiki." };
  try {
    return { ok: true, ...(await edits.savePage(actor, input)) };
  } catch (error) {
    if (error instanceof ContentConflictError) {
      // Someone saved first. Hand back their version so the editor can show both.
      const theirs = await getWikiPage(input.slug, { branch: input.branch });
      return {
        ok: false,
        error: "Someone saved this page on this branch after you opened it.",
        conflict: theirs ? { source: theirs.source, blobSha: theirs.blobSha } : undefined,
      };
    }
    if (error instanceof edits.WikiEditError || isContentError(error)) return { ok: false, error: error.message };
    console.error("Wiki save failed", error);
    return { ok: false, error: "Atlas could not save this page. Try again." };
  }
}

export async function restoreVersionAction(input: { branch: string; slug: string; fromSha: string; expectedBlobSha: string | null }) {
  return run((actor) => edits.restoreVersion(actor, input));
}

export async function deleteBranchAction(branch: string) {
  return run(async (actor) => {
    await edits.deleteBranch(actor, branch);
    return {};
  });
}

export async function openChangeRequestAction(input: { branch: string; title: string; description: string }) {
  return run(async (actor) => ({ number: (await changes.openChangeRequest(actor, input)).number }));
}

export async function reviewAction(number: number, verdict: ReviewVerdict, body: string) {
  return run(async (actor) => {
    await changes.reviewChangeRequest(actor, number, verdict, body);
    return {};
  });
}

export async function mergeAction(number: number) {
  return run((actor) => changes.mergeChangeRequest(actor, number));
}

export async function updateBranchAction(number: number) {
  return run(async (actor) => {
    await changes.updateChangeRequestBranch(actor, number);
    return {};
  });
}

export async function closeChangeRequestAction(number: number) {
  return run(async (actor) => {
    await changes.closeChangeRequest(actor, number);
    return {};
  });
}

export async function rollbackAction(input: { sha: string; branch?: string | null }) {
  return run(async (actor) => {
    const { rollBack } = await import("@/lib/rollback");
    return rollBack(actor, input);
  });
}
