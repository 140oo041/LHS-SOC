import { contentStore, readBlob, readFiles, readHead, readMergeBase } from "@/lib/content";
import type { WikiRef } from "@/lib/wiki";
import { resolveWikiRef } from "@/lib/wiki";
import { diffModels, overlayChanges, type ModelDiff } from "./diff";
import { buildGraph, type ArchitectureGraph } from "./graph";
import { MODEL_PATH, parseModel } from "./load";
import type { ArchitectureModel } from "./schema";
import { buildSnapshot, type ViewSnapshot } from "./view";

/**
 * The model at any version: a branch's latest, or one exact commit.
 *
 * The model is read through the content store, like the wiki, so the canvas
 * shows what is on a branch, and a merge shows up without a redeploy.
 * Parsing and indexing 1,800 lines of YAML is the costly part, and a blob
 * never changes, so the result is kept per blob for the life of the process.
 */

export type ModelVersion = {
  model: ArchitectureModel;
  graph: ArchitectureGraph;
  snapshot: ViewSnapshot;
  text: string;
  blobSha: string;
  commitSha: string;
};

const parsed = new Map<string, Omit<ModelVersion, "commitSha">>();
const KEEP = 12;

function fromBlob(blobSha: string, text: string) {
  const hit = parsed.get(blobSha);
  if (hit) {
    // Refresh its place so the most used versions stay.
    parsed.delete(blobSha);
    parsed.set(blobSha, hit);
    return hit;
  }
  const model = parseModel(text);
  const graph = buildGraph(model);
  const entry = { model, graph, snapshot: buildSnapshot(graph), text, blobSha };
  parsed.set(blobSha, entry);
  if (parsed.size > KEEP) parsed.delete(parsed.keys().next().value!);
  return entry;
}

/** The model at a commit, or null when that commit has no model file. */
export async function modelAtCommit(commitSha: string): Promise<ModelVersion | null> {
  const file = (await readFiles(commitSha, "architecture")).find((entry) => entry.path === MODEL_PATH);
  if (!file) return null;
  return { ...fromBlob(file.blobSha, await readBlob(file.blobSha)), commitSha };
}

export async function modelAt(ref?: WikiRef): Promise<ModelVersion | null> {
  const commitSha = await resolveWikiRef(ref);
  return commitSha ? modelAtCommit(commitSha) : null;
}

/** The published model: the default branch's latest. */
export async function publishedModel() {
  const version = await modelAt();
  if (!version) throw new Error(`${MODEL_PATH} is missing from the default branch`);
  return version;
}

/**
 * What a branch changes in the model since it left the default branch,
 * which is what merging its change request would apply.
 */
export async function branchModelChanges(branch: string): Promise<{ base: ModelVersion; head: ModelVersion; diff: ModelDiff } | null> {
  const store = await contentStore();
  if (branch === store.defaultBranch) return null;
  const [baseHead, branchHead] = await Promise.all([readHead(store.defaultBranch), readHead(branch)]);
  if (!baseHead || !branchHead) return null;
  const mergeBase = await readMergeBase(baseHead, branchHead);
  const [base, head] = await Promise.all([modelAtCommit(mergeBase), modelAtCommit(branchHead)]);
  if (!base || !head) return null;
  return { base, head, diff: base.blobSha === head.blobSha ? { blocks: [], connections: [], sections: [] } : diffModels(base.model, head.model) };
}

/** The snapshot the canvas draws for a branch, with its changes marked. */
export function snapshotWithChanges(changes: NonNullable<Awaited<ReturnType<typeof branchModelChanges>>>): ViewSnapshot {
  return overlayChanges(changes.head.snapshot, changes.base.snapshot, changes.diff, changes.base.commitSha);
}
