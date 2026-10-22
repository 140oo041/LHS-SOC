import { github, type GithubSettings } from "@/lib/content/github-app";
import {
  ContentConflictError,
  ContentNotFoundError,
  ContentRefusedError,
  type BranchInfo,
  type CommitSummary,
  type Comparison,
  type ContentStore,
  type FileEntry,
  type GraphCommit,
  type PullRequest,
  type TreeChange,
  type WriteFileInput,
} from "@/lib/content/types";

export type GithubPull = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  merged?: boolean;
  merged_at: string | null;
  mergeable?: boolean | null;
  merge_commit_sha: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
};

// Branch names may contain slashes, which GitHub expects unescaped in ref
// paths; everything else in a segment is escaped.
const refPath = (branch: string) => branch.split("/").map(encodeURIComponent).join("/");

export function mapPull(pull: GithubPull): PullRequest {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.state,
    merged: Boolean(pull.merged ?? pull.merged_at),
    headRef: pull.head.ref,
    headSha: pull.head.sha,
    baseRef: pull.base.ref,
    mergeable: pull.mergeable ?? null,
    authorLogin: pull.user?.login,
    htmlUrl: pull.html_url,
    mergeCommitSha: pull.merge_commit_sha ?? undefined,
  };
}

type GithubCommit = {
  sha: string;
  parents: Array<{ sha: string }>;
  commit: { message: string; author: { name: string; date: string } | null; committer?: { date: string } | null };
};

function mapCommit(commit: GithubCommit): GraphCommit {
  return {
    sha: commit.sha,
    parents: commit.parents.map((parent) => parent.sha),
    message: commit.commit.message,
    authorName: commit.commit.author?.name ?? "unknown",
    atlasUser: commit.commit.message.match(/^Atlas-User: (.+)$/m)?.[1],
    date: commit.commit.committer?.date ?? commit.commit.author?.date ?? "",
  };
}

export class GithubContentStore implements ContentStore {
  readonly kind = "github" as const;
  readonly defaultBranch: string;

  constructor(private readonly settings: GithubSettings) {
    this.defaultBranch = settings.defaultBranch;
  }

  private call<T>(path: string, init?: { method?: string; body?: unknown }) {
    return github<T>(this.settings, path, init);
  }

  async resolveHead(branch: string) {
    try {
      const ref = await this.call<{ object: { sha: string } }>(`/git/ref/heads/${refPath(branch)}`);
      return ref.object.sha;
    } catch (error) {
      if (error instanceof ContentNotFoundError) return null;
      throw error;
    }
  }

  async listBranches(): Promise<BranchInfo[]> {
    const branches: BranchInfo[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const batch = await this.call<Array<{ name: string; commit: { sha: string } }>>(`/branches?per_page=100&page=${page}`);
      branches.push(...batch.map((branch) => ({ name: branch.name, headSha: branch.commit.sha })));
      if (batch.length < 100) break;
    }
    return branches;
  }

  async listFiles(commitSha: string, dir: string): Promise<FileEntry[]> {
    const prefix = dir ? `${dir.replace(/\/$/, "")}/` : "";
    const tree = await this.call<{ tree: Array<{ path: string; type: string; sha: string }>; truncated: boolean }>(
      `/git/trees/${commitSha}?recursive=1`,
    );
    return tree.tree
      .filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
      .map((entry) => ({ path: entry.path, blobSha: entry.sha }));
  }

  async readBlob(blobSha: string) {
    const blob = await this.call<{ content: string; encoding: string }>(`/git/blobs/${blobSha}`);
    return Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  }

  async writeFile(input: WriteFileInput) {
    try {
      const result = await this.call<{ content: { sha: string }; commit: { sha: string } }>(
        `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
        {
          method: "PUT",
          body: {
            message: input.message,
            content: Buffer.from(input.content, "utf8").toString("base64"),
            branch: input.branch,
            // GitHub refuses the write unless this matches the file's current
            // blob, which is exactly the "someone saved first" check needed.
            ...(input.expectedBlobSha ? { sha: input.expectedBlobSha } : {}),
          },
        },
      );
      return { commitSha: result.commit.sha, blobSha: result.content.sha };
    } catch (error) {
      // Creating a file that already exists is a 422 asking for its sha.
      if (error instanceof ContentRefusedError && !input.expectedBlobSha) {
        throw new ContentConflictError(`${input.path} already exists on ${input.branch}`);
      }
      throw error;
    }
  }

  async createBranch(name: string, fromSha: string) {
    try {
      await this.call("/git/refs", { method: "POST", body: { ref: `refs/heads/${name}`, sha: fromSha } });
    } catch (error) {
      if (error instanceof ContentRefusedError) throw new ContentConflictError(`Branch ${name} already exists`);
      throw error;
    }
  }

  async deleteBranch(name: string) {
    await this.call(`/git/refs/heads/${refPath(name)}`, { method: "DELETE" });
  }

  async fileHistory(branch: string, path: string, limit: number): Promise<CommitSummary[]> {
    const commits = await this.call<Array<{ sha: string; commit: { message: string; author: { name: string; date: string } | null } }>>(
      `/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=${Math.min(limit, 100)}`,
    );
    return commits.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      authorName: commit.commit.author?.name ?? "unknown",
      atlasUser: commit.commit.message.match(/^Atlas-User: (.+)$/m)?.[1],
      date: commit.commit.author?.date ?? "",
    }));
  }

  async listCommits(heads: string[], limit: number): Promise<GraphCommit[]> {
    const found = new Map<string, GraphCommit>();
    for (const head of heads) {
      for (const commit of await this.call<GithubCommit[]>(`/commits?sha=${head}&per_page=${Math.min(limit, 100)}`)) {
        found.set(commit.sha, mapCommit(commit));
      }
    }
    return [...found.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  async getCommit(sha: string) {
    try {
      return mapCommit(await this.call<GithubCommit>(`/commits/${sha}`));
    } catch (error) {
      if (error instanceof ContentNotFoundError || error instanceof ContentRefusedError) return null;
      throw error;
    }
  }

  /**
   * Through the Git Data API: a tree on top of the head's, a commit on top of
   * the head, then a fast-forward of the branch. GitHub refuses the last step
   * if the branch moved in between, which is the concurrency check.
   */
  async commitTree(input: { branch: string; expectedHeadSha: string; changes: TreeChange[]; message: string }) {
    if ((await this.resolveHead(input.branch)) !== input.expectedHeadSha) {
      throw new ContentConflictError(`${input.branch} moved on since you looked at it`);
    }
    const head = await this.call<{ tree: { sha: string } }>(`/git/commits/${input.expectedHeadSha}`);
    const tree = await this.call<{ sha: string }>("/git/trees", {
      method: "POST",
      body: { base_tree: head.tree.sha, tree: input.changes.map((change) => ({ path: change.path, mode: "100644", type: "blob", sha: change.blobSha })) },
    });
    const commit = await this.call<{ sha: string }>("/git/commits", {
      method: "POST",
      body: { message: input.message, tree: tree.sha, parents: [input.expectedHeadSha] },
    });
    try {
      await this.call(`/git/refs/heads/${refPath(input.branch)}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
    } catch (error) {
      if (error instanceof ContentRefusedError) throw new ContentConflictError(`${input.branch} moved on since you looked at it`);
      throw error;
    }
    return { commitSha: commit.sha };
  }

  async compare(baseSha: string, headSha: string): Promise<Comparison> {
    const result = await this.call<{
      ahead_by: number;
      behind_by: number;
      merge_base_commit: { sha: string };
      files?: Array<{ filename: string; status: string; previous_filename?: string; patch?: string }>;
    }>(`/compare/${baseSha}...${headSha}`);
    return {
      mergeBaseSha: result.merge_base_commit.sha,
      aheadBy: result.ahead_by,
      behindBy: result.behind_by,
      files: (result.files ?? []).map((file) => ({
        path: file.filename,
        status: file.status === "added" || file.status === "removed" || file.status === "renamed" ? file.status : "modified",
        previousPath: file.previous_filename,
        patch: file.patch,
      })),
    };
  }

  async openPullRequest(input: { head: string; base: string; title: string; body: string }) {
    try {
      return mapPull(await this.call<GithubPull>("/pulls", { method: "POST", body: input }));
    } catch (error) {
      if (error instanceof ContentRefusedError && /already exists/i.test(error.message)) {
        throw new ContentConflictError(`A change request is already open for ${input.head}`);
      }
      throw error;
    }
  }

  async getPullRequest(number: number) {
    try {
      return mapPull(await this.call<GithubPull>(`/pulls/${number}`));
    } catch (error) {
      if (error instanceof ContentNotFoundError) return null;
      throw error;
    }
  }

  async listOpenPullRequests() {
    return (await this.call<GithubPull[]>("/pulls?state=open&per_page=100")).map(mapPull);
  }

  async mergePullRequest(input: { number: number; expectedHeadSha: string; title: string; message: string }) {
    try {
      const result = await this.call<{ sha: string }>(`/pulls/${input.number}/merge`, {
        method: "PUT",
        // `sha` makes GitHub refuse if anything was pushed after approval.
        body: { sha: input.expectedHeadSha, merge_method: "squash", commit_title: input.title, commit_message: input.message },
      });
      return { sha: result.sha };
    } catch (error) {
      // GitHub answers 409 when head moved past `sha`; older API versions
      // used 422 with the same message.
      if ((error instanceof ContentConflictError || error instanceof ContentRefusedError) && /head branch was modified|sha/i.test(error.message)) {
        throw new ContentConflictError("The branch changed after it was approved");
      }
      throw error;
    }
  }

  async updatePullRequestBranch(number: number, expectedHeadSha: string) {
    await this.call(`/pulls/${number}/update-branch`, { method: "PUT", body: { expected_head_sha: expectedHeadSha } });
  }

  async closePullRequest(number: number) {
    await this.call(`/pulls/${number}`, { method: "PATCH", body: { state: "closed" } });
  }
}
