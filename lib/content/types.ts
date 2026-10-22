/**
 * Where wiki content lives, and how it is versioned.
 *
 * The interface is Git's own vocabulary on purpose: branches, commits, blobs,
 * pull requests. Two implementations exist. The GitHub store is the real one;
 * Atlas branches are branches of the repository and change requests are pull
 * requests, so anything done in Atlas is visible from a clone and anything
 * pushed from a clone is visible in Atlas. The memory store is a tiny Git in
 * process, used for local development and tests.
 */

export type FileEntry = { path: string; blobSha: string };

export type BranchInfo = { name: string; headSha: string };

export type CommitSummary = {
  sha: string;
  message: string;
  authorName: string;
  /** The Atlas user who made the change, from the commit's Atlas-User trailer. */
  atlasUser?: string;
  date: string;
};

/** A commit with its parents: what a history graph is drawn from. */
export type GraphCommit = CommitSummary & { parents: string[] };

/** One path in a multi-file commit: the blob it should hold, or null to delete it. */
export type TreeChange = { path: string; blobSha: string | null };

export type ComparedFile = {
  path: string;
  status: "added" | "modified" | "removed" | "renamed";
  previousPath?: string;
  /** Unified diff hunks. Absent when the provider omits them, e.g. for very large files. */
  patch?: string;
};

export type Comparison = {
  mergeBaseSha: string;
  /** Commits on head that base lacks. */
  aheadBy: number;
  /** Commits on base that head lacks. */
  behindBy: number;
  /** Changes on head since the merge base, which is what merging would apply. */
  files: ComparedFile[];
};

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  /** null while the provider is still working it out. */
  mergeable: boolean | null;
  authorLogin?: string;
  htmlUrl?: string;
  mergeCommitSha?: string;
};

export type WriteFileInput = {
  branch: string;
  path: string;
  content: string;
  /** The blob the editor started from, or null for a new file. */
  expectedBlobSha: string | null;
  message: string;
};

export interface ContentStore {
  readonly kind: "github" | "memory";
  readonly defaultBranch: string;

  resolveHead(branch: string): Promise<string | null>;
  listBranches(): Promise<BranchInfo[]>;
  /** Every file under `dir` at a commit. */
  listFiles(commitSha: string, dir: string): Promise<FileEntry[]>;
  readBlob(blobSha: string): Promise<string>;

  writeFile(input: WriteFileInput): Promise<{ commitSha: string; blobSha: string }>;
  createBranch(name: string, fromSha: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  fileHistory(branch: string, path: string, limit: number): Promise<CommitSummary[]>;
  /** Commits reachable from these heads, newest first, at most `limit` per head. */
  listCommits(heads: string[], limit: number): Promise<GraphCommit[]>;
  getCommit(sha: string): Promise<GraphCommit | null>;
  /**
   * One commit setting several paths to existing blobs (or deleting them),
   * made only if the branch is still at `expectedHeadSha`.
   */
  commitTree(input: { branch: string; expectedHeadSha: string; changes: TreeChange[]; message: string }): Promise<{ commitSha: string }>;
  compare(baseSha: string, headSha: string): Promise<Comparison>;

  openPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequest>;
  getPullRequest(number: number): Promise<PullRequest | null>;
  listOpenPullRequests(): Promise<PullRequest[]>;
  /** Squash-merges, but only if head is still `expectedHeadSha`. */
  mergePullRequest(input: { number: number; expectedHeadSha: string; title: string; message: string }): Promise<{ sha: string }>;
  /** Merges base into head so the request is current. */
  updatePullRequestBranch(number: number, expectedHeadSha: string): Promise<void>;
  closePullRequest(number: number): Promise<void>;
}

/** Someone else changed the thing first; reload and try again. */
export class ContentConflictError extends Error {
  readonly status = 409;
}

export class ContentNotFoundError extends Error {
  readonly status = 404;
}

/** The provider refused, e.g. a merge conflict Git cannot resolve on its own. */
export class ContentRefusedError extends Error {
  readonly status = 422;
}

export type ContentError = ContentConflictError | ContentNotFoundError | ContentRefusedError;

export function isContentError(error: unknown): error is ContentError {
  return error instanceof ContentConflictError || error instanceof ContentNotFoundError || error instanceof ContentRefusedError;
}
