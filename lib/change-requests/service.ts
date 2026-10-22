import { randomUUID } from "node:crypto";
import { contentStore, expireBranch, expireBranchList } from "@/lib/content";
import { isAtlasBranch } from "@/lib/content/branch-name";
import type { Comparison, PullRequest } from "@/lib/content/types";
import { hasDatabase, query, transaction } from "@/lib/db";
import { canAdmin, canEdit, WORKSPACE_SLUG, type Actor } from "@/lib/domain";
import { evaluateMerge, reviewRefusal, type Review, type ReviewVerdict } from "@/lib/change-requests/policy";
import { lookupAccess, recordAudit } from "@/lib/roles";

/**
 * Wiki change requests: a pull request on GitHub plus Atlas's record of its
 * review. Git decides what the content is and whether it merges cleanly;
 * Atlas decides who may approve and merge, and remembers which exact commit
 * each approval covered.
 */

export type ChangeRequestStatus = "open" | "merged" | "closed";

export type ChangeRequest = {
  id: string;
  number: number;
  branch: string;
  baseBranch: string;
  title: string;
  description: string;
  authorEmail: string | null;
  authorGithubLogin: string | null;
  status: ChangeRequestStatus;
  headSha: string;
  mergeCommitSha: string | null;
  mergedByEmail: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class ChangeRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

type MemoryChanges = { requests: Map<number, ChangeRequest>; reviews: Map<string, Review[]> };

declare global {
  var __atlasChangeRequests: MemoryChanges | undefined;
}

function memory() {
  globalThis.__atlasChangeRequests ??= { requests: new Map(), reviews: new Map() };
  return globalThis.__atlasChangeRequests;
}

const now = () => new Date().toISOString();
const iso = (value: unknown) => (value ? new Date(String(value)).toISOString() : null);

function mapRequest(row: Record<string, unknown>): ChangeRequest {
  return {
    id: String(row.id),
    number: Number(row.pr_number),
    branch: String(row.branch),
    baseBranch: String(row.base_branch),
    title: String(row.title),
    description: String(row.description ?? ""),
    authorEmail: row.author_email ? String(row.author_email) : null,
    authorGithubLogin: row.author_github_login ? String(row.author_github_login) : null,
    status: row.status as ChangeRequestStatus,
    headSha: String(row.head_sha),
    mergeCommitSha: row.merge_commit_sha ? String(row.merge_commit_sha) : null,
    mergedByEmail: row.merged_by_email ? String(row.merged_by_email) : null,
    mergedAt: iso(row.merged_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapReview(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    reviewerEmail: String(row.reviewer_email),
    verdict: row.verdict as ReviewVerdict,
    headSha: String(row.head_sha),
    body: String(row.body ?? ""),
    dismissed: Boolean(row.dismissed_at),
    createdAt: iso(row.created_at)!,
  };
}

export async function listChangeRequests(status?: ChangeRequestStatus): Promise<ChangeRequest[]> {
  if (!hasDatabase()) {
    return [...memory().requests.values()]
      .filter((request) => !status || request.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((request) => structuredClone(request));
  }
  const result = await query(
    `SELECT c.* FROM change_requests c JOIN workspaces w ON w.id = c.workspace_id
     WHERE w.slug = $1 AND ($2::text IS NULL OR c.status = $2) ORDER BY c.updated_at DESC LIMIT 200`,
    [WORKSPACE_SLUG, status ?? null],
  );
  return result.rows.map(mapRequest);
}

async function findRequest(number: number): Promise<ChangeRequest | null> {
  if (!hasDatabase()) {
    const request = memory().requests.get(number);
    return request ? structuredClone(request) : null;
  }
  const result = await query("SELECT * FROM change_requests WHERE pr_number = $1", [number]);
  return result.rows[0] ? mapRequest(result.rows[0]) : null;
}

export async function openChangeRequestFor(branch: string): Promise<ChangeRequest | null> {
  return (await listChangeRequests("open")).find((request) => request.branch === branch) ?? null;
}

async function listReviews(request: ChangeRequest): Promise<Review[]> {
  if (!hasDatabase()) return structuredClone(memory().reviews.get(request.id) ?? []);
  const result = await query("SELECT * FROM change_request_reviews WHERE change_request_id = $1 ORDER BY created_at", [request.id]);
  return result.rows.map(mapReview);
}

/**
 * Brings Atlas's record in line with the pull request: its head, and whether
 * it was merged or closed, possibly on GitHub directly. A new head dismisses
 * every review of an older one. Creates the record for a pull request opened
 * outside Atlas, so those get the same review rule.
 */
export async function syncFromPull(pull: PullRequest): Promise<ChangeRequest | null> {
  const store = await contentStore();
  if (pull.baseRef !== store.defaultBranch) return null;
  const status: ChangeRequestStatus = pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open";
  const existing = await findRequest(pull.number);

  if (!hasDatabase()) {
    const request: ChangeRequest = existing ?? {
      id: randomUUID(),
      number: pull.number,
      branch: pull.headRef,
      baseBranch: pull.baseRef,
      title: pull.title,
      description: pull.body,
      authorEmail: null,
      authorGithubLogin: pull.authorLogin ?? null,
      status,
      headSha: pull.headSha,
      mergeCommitSha: null,
      mergedByEmail: null,
      mergedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    if (existing && existing.headSha !== pull.headSha && pull.headSha) {
      for (const review of memory().reviews.get(request.id) ?? []) if (review.headSha !== pull.headSha) review.dismissed = true;
    }
    Object.assign(request, {
      status: existing?.status === "merged" ? "merged" : status,
      headSha: pull.headSha || request.headSha,
      mergeCommitSha: request.mergeCommitSha ?? pull.mergeCommitSha ?? null,
      mergedAt: request.mergedAt ?? (pull.merged ? now() : null),
      updatedAt: now(),
    });
    memory().requests.set(pull.number, request);
    return structuredClone(request);
  }

  return transaction(async (client) => {
    const result = await client.query(
      `INSERT INTO change_requests (workspace_id, pr_number, branch, base_branch, title, description, author_github_login, status, head_sha, merge_commit_sha, merged_at)
       SELECT w.id, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $8 = 'merged' THEN now() END FROM workspaces w WHERE w.slug = $1
       ON CONFLICT (pr_number) DO UPDATE SET
         status = CASE WHEN change_requests.status = 'merged' THEN 'merged' ELSE EXCLUDED.status END,
         head_sha = COALESCE(NULLIF(EXCLUDED.head_sha, ''), change_requests.head_sha),
         merge_commit_sha = COALESCE(change_requests.merge_commit_sha, EXCLUDED.merge_commit_sha),
         merged_at = COALESCE(change_requests.merged_at, EXCLUDED.merged_at),
         closed_at = CASE WHEN EXCLUDED.status = 'closed' THEN COALESCE(change_requests.closed_at, now()) ELSE change_requests.closed_at END,
         updated_at = now()
       RETURNING *`,
      [WORKSPACE_SLUG, pull.number, pull.headRef, pull.baseRef, pull.title, pull.body, pull.authorLogin ?? null, status, pull.headSha, pull.mergeCommitSha ?? null],
    );
    const request = mapRequest(result.rows[0]);
    await client.query(
      "UPDATE change_request_reviews SET dismissed_at = now() WHERE change_request_id = $1 AND head_sha <> $2 AND dismissed_at IS NULL",
      [request.id, request.headSha],
    );
    return request;
  });
}

export async function openChangeRequest(actor: Actor, input: { branch: string; title: string; description: string }) {
  if (!canEdit(actor.role)) throw new ChangeRequestError("Proposing changes needs the editor role", 403);
  if (!isAtlasBranch(input.branch)) throw new ChangeRequestError("Only Atlas branches can be proposed from Atlas", 400);
  const store = await contentStore();
  const comparison = await compareWithBase(input.branch);
  if (!comparison?.aheadBy) throw new ChangeRequestError("This branch has no changes to propose yet", 409);

  const pull = await store.openPullRequest({
    head: input.branch,
    base: store.defaultBranch,
    title: input.title,
    body: `${input.description}\n\n---\nProposed in Atlas by ${actor.email}. Review and merge happen in Atlas.`.trim(),
  });

  let request: ChangeRequest;
  if (!hasDatabase()) {
    request = {
      id: randomUUID(),
      number: pull.number,
      branch: input.branch,
      baseBranch: store.defaultBranch,
      title: input.title,
      description: input.description,
      authorEmail: actor.email,
      authorGithubLogin: null,
      status: "open",
      headSha: pull.headSha,
      mergeCommitSha: null,
      mergedByEmail: null,
      mergedAt: null,
      createdAt: now(),
      updatedAt: now(),
    };
    memory().requests.set(pull.number, request);
  } else {
    // The pull_request webhook may have created the row first; either way
    // the author recorded is the Atlas user, not the App.
    const result = await query(
      `INSERT INTO change_requests (workspace_id, pr_number, branch, base_branch, title, description, author_email, status, head_sha)
       SELECT w.id, $2, $3, $4, $5, $6, $7, 'open', $8 FROM workspaces w WHERE w.slug = $1
       ON CONFLICT (pr_number) DO UPDATE SET author_email = EXCLUDED.author_email, title = EXCLUDED.title, description = EXCLUDED.description
       RETURNING *`,
      [WORKSPACE_SLUG, pull.number, input.branch, store.defaultBranch, input.title, input.description, actor.email, pull.headSha],
    );
    request = mapRequest(result.rows[0]);
  }
  await recordAudit(actor, "wiki.change.open", `#${pull.number}`, { branch: input.branch });
  return request;
}

/** What merging this branch would change, relative to the published wiki. */
export async function compareWithBase(branch: string): Promise<Comparison | null> {
  const store = await contentStore();
  const [base, head] = await Promise.all([store.resolveHead(store.defaultBranch), store.resolveHead(branch)]);
  if (!base || !head) return null;
  return store.compare(base, head);
}

export type ChangeRequestDetail = {
  request: ChangeRequest;
  reviews: Review[];
  pull: PullRequest | null;
  comparison: Comparison | null;
};

/** Everything the review page shows, read live from GitHub. */
export async function getChangeRequest(number: number): Promise<ChangeRequestDetail | null> {
  const store = await contentStore();
  const pull = await store.getPullRequest(number);
  let request = pull ? await syncFromPull(pull) : await findRequest(number);
  if (!request) request = await findRequest(number);
  if (!request) return null;
  const comparison = request.status === "open" ? await compareWithBase(request.branch).catch(() => null) : null;
  return { request, reviews: await listReviews(request), pull, comparison };
}

async function requireOpen(number: number) {
  const detail = await getChangeRequest(number);
  if (!detail) throw new ChangeRequestError("Change request not found", 404);
  if (detail.request.status !== "open" || !detail.pull) throw new ChangeRequestError("This change request is no longer open", 409);
  return detail as ChangeRequestDetail & { pull: PullRequest };
}

export async function reviewChangeRequest(actor: Actor, number: number, verdict: ReviewVerdict, body: string) {
  const { request, pull } = await requireOpen(number);
  const refusal = reviewRefusal(actor, request.authorEmail, verdict);
  if (refusal) throw new ChangeRequestError(refusal, 403);
  if (verdict !== "approved" && !body.trim()) throw new ChangeRequestError("Say what needs to change", 400);

  const review: Review = { id: randomUUID(), reviewerEmail: actor.email, verdict, headSha: pull.headSha, body: body.trim(), dismissed: false, createdAt: now() };
  if (!hasDatabase()) {
    memory().reviews.set(request.id, [...(memory().reviews.get(request.id) ?? []), review]);
  } else {
    await query(
      "INSERT INTO change_request_reviews (id, change_request_id, reviewer_email, verdict, head_sha, body) VALUES ($1, $2, $3, $4, $5, $6)",
      [review.id, request.id, review.reviewerEmail, review.verdict, review.headSha, review.body],
    );
  }
  await recordAudit(actor, `wiki.change.${verdict}`, `#${number}`, { headSha: pull.headSha });
  return review;
}

/** The merge rule, evaluated against live state, for display and for merging. */
export async function mergeReadiness(actor: Actor, detail: ChangeRequestDetail) {
  const reviewers = [...new Set(detail.reviews.map((review) => review.reviewerEmail))];
  const roles = new Map(
    await Promise.all(
      reviewers.map(async (email) => {
        const access = await lookupAccess(email);
        return [email, access.admitted ? access.role : null] as const;
      }),
    ),
  );
  return evaluateMerge({
    actor,
    status: detail.request.status,
    authorEmail: detail.request.authorEmail,
    headSha: detail.pull?.headSha ?? detail.request.headSha,
    mergeable: detail.pull?.mergeable ?? null,
    reviews: detail.reviews,
    roleOf: (email) => roles.get(email) ?? null,
  });
}

export async function mergeChangeRequest(actor: Actor, number: number) {
  const detail = await requireOpen(number);
  const { request, pull, reviews } = detail;
  const readiness = await mergeReadiness(actor, detail);
  if (!readiness.allowed) throw new ChangeRequestError(readiness.reasons.join(" "), canAdmin(actor.role) ? 409 : 403);

  const approvers = [...new Set(reviews.filter((review) => !review.dismissed && review.verdict === "approved" && review.headSha === pull.headSha).map((review) => review.reviewerEmail))];
  const message = [
    request.description,
    "",
    ...(request.authorEmail ? [`Atlas-User: ${request.authorEmail}`, `Co-authored-by: ${request.authorEmail.split("@")[0]} <${request.authorEmail}>`] : []),
    ...approvers.map((email) => `Approved-by: ${email}`),
    `Merged-by: ${actor.email}`,
  ].join("\n").trim();

  const store = await contentStore();
  const { sha } = await store.mergePullRequest({ number, expectedHeadSha: pull.headSha, title: `${request.title} (#${number})`, message });

  if (!hasDatabase()) {
    Object.assign(memory().requests.get(number)!, { status: "merged", mergeCommitSha: sha, mergedByEmail: actor.email, mergedAt: now(), updatedAt: now() });
  } else {
    await query(
      `UPDATE change_requests SET status = 'merged', merge_commit_sha = $2, merged_by_email = $3, merged_at = now(), updated_at = now()
       WHERE pr_number = $1`,
      [number, sha, actor.email],
    );
  }
  await recordAudit(actor, "wiki.change.merge", `#${number}`, { sha, approvers });
  // The branch has served its purpose. Failing to delete it is harmless.
  await store.deleteBranch(request.branch).catch(() => undefined);
  await expireBranch(store.defaultBranch, request.branch);
  await expireBranchList();
  return { sha };
}

/** Merges the published wiki into the branch, so it is current and mergeable. */
export async function updateChangeRequestBranch(actor: Actor, number: number) {
  if (!canEdit(actor.role)) throw new ChangeRequestError("Updating a branch needs the editor role", 403);
  const { request, pull } = await requireOpen(number);
  await (await contentStore()).updatePullRequestBranch(number, pull.headSha);
  await expireBranch(request.branch);
}

export async function closeChangeRequest(actor: Actor, number: number) {
  const { request } = await requireOpen(number);
  if (request.authorEmail !== actor.email && !canAdmin(actor.role)) {
    throw new ChangeRequestError("Only the author or an administrator can close this", 403);
  }
  await (await contentStore()).closePullRequest(number);
  if (!hasDatabase()) Object.assign(memory().requests.get(number)!, { status: "closed", updatedAt: now() });
  else await query("UPDATE change_requests SET status = 'closed', closed_at = now(), updated_at = now() WHERE pr_number = $1", [number]);
  await recordAudit(actor, "wiki.change.close", `#${number}`);
}

/** Catches up on anything a missed webhook delivery would have told Atlas. */
export async function reconcileChangeRequests() {
  const store = await contentStore();
  const open = await store.listOpenPullRequests();
  for (const pull of open) await syncFromPull(pull);
  const stillOpen = new Set(open.map((pull) => pull.number));
  let closed = 0;
  for (const request of await listChangeRequests("open")) {
    if (stillOpen.has(request.number)) continue;
    const pull = await store.getPullRequest(request.number);
    if (pull) await syncFromPull(pull);
    closed += 1;
  }
  return { open: open.length, closed };
}
