import { createHash } from "node:crypto";
import { unifiedPatch } from "@/lib/content/diff";
import {
  ContentConflictError,
  ContentNotFoundError,
  ContentRefusedError,
  type BranchInfo,
  type CommitSummary,
  type Comparison,
  type ComparedFile,
  type ContentStore,
  type FileEntry,
  type GraphCommit,
  type PullRequest,
  type TreeChange,
  type WriteFileInput,
} from "@/lib/content/types";

/**
 * A small Git in process: content-addressed blobs, commits with parents,
 * branch refs, and pull requests with squash merges.
 *
 * It exists so every wiki workflow (branch, edit, review, conflict, merge)
 * runs and is tested without GitHub. It is not durable: on a host it only
 * ever serves the bundled `docs/` read-only (see lib/content/index.ts).
 */

type Tree = Map<string, string>; // path -> blob sha

type Commit = {
  sha: string;
  parents: string[];
  tree: Tree;
  message: string;
  authorName: string;
  date: string;
};

type MemoryPull = Omit<PullRequest, "headSha" | "mergeable">;

export type MemoryRepository = {
  blobs: Map<string, string>;
  commits: Map<string, Commit>;
  refs: Map<string, string>;
  pulls: Map<number, MemoryPull>;
  nextPull: number;
};

export function blobSha(content: string) {
  // Git's own blob hash, so shas look and behave like the real thing.
  return createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
}

let clock = 0;

function commitSha(parents: string[], tree: Tree, message: string) {
  clock += 1;
  return createHash("sha1")
    .update(JSON.stringify({ parents, tree: [...tree], message, clock }))
    .digest("hex");
}

function atlasUser(message: string) {
  return message.match(/^Atlas-User: (.+)$/m)?.[1];
}

export function createMemoryRepository(defaultBranch: string, files: Record<string, string>): MemoryRepository {
  const repo: MemoryRepository = { blobs: new Map(), commits: new Map(), refs: new Map(), pulls: new Map(), nextPull: 1 };
  const tree: Tree = new Map();
  for (const [path, content] of Object.entries(files)) {
    const sha = blobSha(content);
    repo.blobs.set(sha, content);
    tree.set(path, sha);
  }
  const sha = commitSha([], tree, "Initial content");
  repo.commits.set(sha, { sha, parents: [], tree, message: "Initial content", authorName: "Atlas", date: new Date().toISOString() });
  repo.refs.set(defaultBranch, sha);
  return repo;
}

export class MemoryContentStore implements ContentStore {
  readonly kind = "memory" as const;

  constructor(
    private readonly repo: MemoryRepository,
    readonly defaultBranch: string,
  ) {}

  private commit(sha: string) {
    const commit = this.repo.commits.get(sha);
    if (!commit) throw new ContentNotFoundError(`Commit ${sha.slice(0, 7)} does not exist`);
    return commit;
  }

  private head(branch: string) {
    const sha = this.repo.refs.get(branch);
    if (!sha) throw new ContentNotFoundError(`Branch ${branch} does not exist`);
    return sha;
  }

  private addCommit(parents: string[], tree: Tree, message: string, authorName = "Atlas") {
    const sha = commitSha(parents, tree, message);
    this.repo.commits.set(sha, { sha, parents, tree, message, authorName, date: new Date().toISOString() });
    return sha;
  }

  private ancestors(sha: string) {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...this.commit(next).parents);
    }
    return seen;
  }

  private mergeBase(a: string, b: string) {
    const fromA = this.ancestors(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length) {
      const next = queue.shift()!;
      if (fromA.has(next)) return next;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...this.commit(next).parents);
    }
    throw new ContentRefusedError("These versions share no history");
  }

  /** Paths whose blob differs between two trees. */
  private changedPaths(from: Tree, to: Tree) {
    const paths = new Set([...from.keys(), ...to.keys()]);
    return [...paths].filter((path) => from.get(path) !== to.get(path));
  }

  /** Applies the changes `base -> source` onto `target`, or reports a clash. */
  private applyChanges(target: Tree, base: Tree, source: Tree) {
    const result = new Map(target);
    const clashes: string[] = [];
    for (const path of this.changedPaths(base, source)) {
      if (target.get(path) !== base.get(path) && target.get(path) !== source.get(path)) clashes.push(path);
      const sha = source.get(path);
      if (sha) result.set(path, sha);
      else result.delete(path);
    }
    return { tree: result, clashes };
  }

  async resolveHead(branch: string) {
    return this.repo.refs.get(branch) ?? null;
  }

  async listBranches(): Promise<BranchInfo[]> {
    return [...this.repo.refs].map(([name, headSha]) => ({ name, headSha })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listFiles(commitSha: string, dir: string): Promise<FileEntry[]> {
    const prefix = dir ? `${dir.replace(/\/$/, "")}/` : "";
    return [...this.commit(commitSha).tree]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, sha]) => ({ path, blobSha: sha }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readBlob(sha: string) {
    const content = this.repo.blobs.get(sha);
    if (content === undefined) throw new ContentNotFoundError(`Blob ${sha.slice(0, 7)} does not exist`);
    return content;
  }

  async writeFile(input: WriteFileInput) {
    const head = this.head(input.branch);
    const tree = new Map(this.commit(head).tree);
    const current = tree.get(input.path) ?? null;
    if (current !== input.expectedBlobSha) {
      throw new ContentConflictError(`${input.path} changed on ${input.branch} since you started editing`);
    }
    const sha = blobSha(input.content);
    this.repo.blobs.set(sha, input.content);
    tree.set(input.path, sha);
    const commitSha = this.addCommit([head], tree, input.message, "atlas-app[bot]");
    this.repo.refs.set(input.branch, commitSha);
    return { commitSha, blobSha: sha };
  }

  async createBranch(name: string, fromSha: string) {
    if (this.repo.refs.has(name)) throw new ContentConflictError(`Branch ${name} already exists`);
    this.commit(fromSha);
    this.repo.refs.set(name, fromSha);
  }

  async deleteBranch(name: string) {
    this.head(name);
    this.repo.refs.delete(name);
  }

  async fileHistory(branch: string, path: string, limit: number): Promise<CommitSummary[]> {
    const history: CommitSummary[] = [];
    let sha: string | undefined = this.head(branch);
    while (sha && history.length < limit) {
      const commit = this.commit(sha);
      const parent = commit.parents[0] ? this.commit(commit.parents[0]) : null;
      if (commit.tree.get(path) !== parent?.tree.get(path) && (commit.tree.has(path) || parent?.tree.has(path))) {
        history.push({ sha: commit.sha, message: commit.message, authorName: commit.authorName, atlasUser: atlasUser(commit.message), date: commit.date });
      }
      sha = commit.parents[0];
    }
    return history;
  }

  private summary(commit: Commit): GraphCommit {
    return { sha: commit.sha, parents: commit.parents, message: commit.message, authorName: commit.authorName, atlasUser: atlasUser(commit.message), date: commit.date };
  }

  async listCommits(heads: string[], limit: number): Promise<GraphCommit[]> {
    const found = new Map<string, Commit>();
    for (const head of heads) {
      let count = 0;
      const queue = [head];
      while (queue.length && count < limit) {
        const sha = queue.shift()!;
        const commit = this.repo.commits.get(sha);
        if (!commit) continue;
        count += 1;
        if (found.has(sha)) continue;
        found.set(sha, commit);
        queue.push(...commit.parents);
      }
    }
    return [...found.values()].sort((a, b) => b.date.localeCompare(a.date)).map((commit) => this.summary(commit));
  }

  async getCommit(sha: string) {
    const commit = this.repo.commits.get(sha);
    return commit ? this.summary(commit) : null;
  }

  async commitTree(input: { branch: string; expectedHeadSha: string; changes: TreeChange[]; message: string }) {
    const head = this.head(input.branch);
    if (head !== input.expectedHeadSha) throw new ContentConflictError(`${input.branch} moved on since you looked at it`);
    const tree = new Map(this.commit(head).tree);
    for (const change of input.changes) {
      if (change.blobSha === null) tree.delete(change.path);
      else {
        if (!this.repo.blobs.has(change.blobSha)) throw new ContentNotFoundError(`Blob ${change.blobSha.slice(0, 7)} does not exist`);
        tree.set(change.path, change.blobSha);
      }
    }
    const commitSha = this.addCommit([head], tree, input.message, "atlas-app[bot]");
    this.repo.refs.set(input.branch, commitSha);
    return { commitSha };
  }

  async compare(baseSha: string, headSha: string): Promise<Comparison> {
    const mergeBaseSha = this.mergeBase(baseSha, headSha);
    const fromBase = this.ancestors(baseSha);
    const fromHead = this.ancestors(headSha);
    const baseTree = this.commit(mergeBaseSha).tree;
    const headTree = this.commit(headSha).tree;
    const files: ComparedFile[] = [];
    for (const path of this.changedPaths(baseTree, headTree)) {
      const before = baseTree.get(path);
      const after = headTree.get(path);
      files.push({
        path,
        status: !before ? "added" : !after ? "removed" : "modified",
        patch: unifiedPatch(before ? await this.readBlob(before) : "", after ? await this.readBlob(after) : ""),
      });
    }
    return {
      mergeBaseSha,
      aheadBy: [...fromHead].filter((sha) => !fromBase.has(sha)).length,
      behindBy: [...fromBase].filter((sha) => !fromHead.has(sha)).length,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  private mergeable(pull: MemoryPull) {
    const base = this.repo.refs.get(pull.baseRef);
    const head = this.repo.refs.get(pull.headRef);
    if (!base || !head) return false;
    const mergeBase = this.commit(this.mergeBase(base, head)).tree;
    return !this.applyChanges(this.commit(base).tree, mergeBase, this.commit(head).tree).clashes.length;
  }

  private present(pull: MemoryPull): PullRequest {
    const headSha = this.repo.refs.get(pull.headRef) ?? "";
    return { ...pull, headSha, mergeable: pull.state === "open" ? this.mergeable(pull) : null };
  }

  async openPullRequest(input: { head: string; base: string; title: string; body: string }) {
    this.head(input.head);
    this.head(input.base);
    const open = [...this.repo.pulls.values()].find((pull) => pull.state === "open" && pull.headRef === input.head);
    if (open) throw new ContentConflictError(`A change request is already open for ${input.head}`);
    const pull: MemoryPull = { number: this.repo.nextPull++, title: input.title, body: input.body, state: "open", merged: false, headRef: input.head, baseRef: input.base };
    this.repo.pulls.set(pull.number, pull);
    return this.present(pull);
  }

  async getPullRequest(number: number) {
    const pull = this.repo.pulls.get(number);
    return pull ? this.present(pull) : null;
  }

  async listOpenPullRequests() {
    return [...this.repo.pulls.values()].filter((pull) => pull.state === "open").map((pull) => this.present(pull));
  }

  async mergePullRequest(input: { number: number; expectedHeadSha: string; title: string; message: string }) {
    const pull = this.repo.pulls.get(input.number);
    if (!pull || pull.state !== "open") throw new ContentNotFoundError("That change request is not open");
    const head = this.head(pull.headRef);
    if (head !== input.expectedHeadSha) throw new ContentConflictError("The branch changed after it was approved");
    const base = this.head(pull.baseRef);
    const mergeBase = this.commit(this.mergeBase(base, head)).tree;
    const { tree, clashes } = this.applyChanges(this.commit(base).tree, mergeBase, this.commit(head).tree);
    if (clashes.length) throw new ContentRefusedError(`Conflicts with ${pull.baseRef} in ${clashes.join(", ")}`);
    const sha = this.addCommit([base], tree, `${input.title}\n\n${input.message}`, "atlas-app[bot]");
    this.repo.refs.set(pull.baseRef, sha);
    Object.assign(pull, { state: "closed", merged: true, mergeCommitSha: sha });
    return { sha };
  }

  async updatePullRequestBranch(number: number, expectedHeadSha: string) {
    const pull = this.repo.pulls.get(number);
    if (!pull || pull.state !== "open") throw new ContentNotFoundError("That change request is not open");
    const head = this.head(pull.headRef);
    if (head !== expectedHeadSha) throw new ContentConflictError("The branch changed; reload and try again");
    const base = this.head(pull.baseRef);
    const mergeBase = this.commit(this.mergeBase(base, head)).tree;
    const { tree, clashes } = this.applyChanges(this.commit(head).tree, mergeBase, this.commit(base).tree);
    if (clashes.length) throw new ContentRefusedError(`Conflicts with ${pull.baseRef} in ${clashes.join(", ")}`);
    this.repo.refs.set(pull.headRef, this.addCommit([head, base], tree, `Merge ${pull.baseRef} into ${pull.headRef}`, "atlas-app[bot]"));
  }

  async closePullRequest(number: number) {
    const pull = this.repo.pulls.get(number);
    if (!pull) throw new ContentNotFoundError("That change request does not exist");
    pull.state = "closed";
  }
}
