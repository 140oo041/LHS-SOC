import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appJwt, decodePrivateKey, githubConfigurationErrors, githubSettings, resetInstallationTokenForTests } from "@/lib/content/github-app";
import { GithubContentStore } from "@/lib/content/github-store";
import { branchNameFromTopic, isAtlasBranch, isReadableBranchName } from "@/lib/content/branch-name";
import { parsePatch, unifiedPatch } from "@/lib/content/diff";
import { verifyGithubSignature } from "@/lib/content/webhook";
import { evaluateMerge, type Review } from "@/lib/change-requests/policy";
import type { Actor } from "@/lib/domain";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

describe("GitHub App credentials", () => {
  it("signs a JWT GitHub will accept", () => {
    const token = appJwt({ appId: "12345", privateKey: pem }, 1_700_000_000);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: "12345" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("reads the key pasted, escaped, or base64-encoded", () => {
    expect(decodePrivateKey(pem)).toBe(pem.trim());
    expect(decodePrivateKey(pem.replace(/\n/g, "\\n"))).toBe(pem.trim());
    expect(decodePrivateKey(Buffer.from(pem).toString("base64"))).toBe(pem.trim());
  });

  it("reports a half-configured or unreadable setup, and nothing when unconfigured", () => {
    expect(githubConfigurationErrors({})).toEqual([]);
    expect(githubConfigurationErrors({ GITHUB_APP_ID: "1" }).join()).toMatch(/half-configured/);
    const complete = { GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_INSTALLATION_ID: "2", GITHUB_REPOSITORY: "o/r", GITHUB_WEBHOOK_SECRET: "s" };
    expect(githubConfigurationErrors(complete)).toEqual([]);
    expect(githubConfigurationErrors({ ...complete, GITHUB_APP_PRIVATE_KEY: "nonsense" }).join()).toMatch(/not a readable private key/);
    expect(githubConfigurationErrors({ ...complete, GITHUB_WEBHOOK_SECRET: undefined }).join()).toMatch(/WEBHOOK_SECRET/);
  });
});

describe("GitHub store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetInstallationTokenForTests();
  });

  function stubGithub(routes: Record<string, (init: RequestInit) => [number, unknown]>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/access_tokens")) return Response.json({ token: "inst-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      const key = `${init.method ?? "GET"} ${url.replace("https://api.github.com/repos/o/r", "")}`;
      const route = routes[key];
      if (!route) return Response.json({ message: `unrouted ${key}` }, { status: 500 });
      const [status, body] = route(init);
      return Response.json(body, { status });
    });
    return calls;
  }

  const store = () =>
    new GithubContentStore(githubSettings({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_INSTALLATION_ID: "2", GITHUB_REPOSITORY: "o/r" }));

  it("uses one installation token across calls and keeps slashes in branch refs", async () => {
    const calls = stubGithub({
      "GET /git/ref/heads/atlas/dma": () => [200, { object: { sha: "a".repeat(40) } }],
      "GET /git/ref/heads/missing": () => [404, { message: "Not Found" }],
    });
    expect(await store().resolveHead("atlas/dma")).toBe("a".repeat(40));
    expect(await store().resolveHead("missing")).toBeNull();
    expect(calls.filter((call) => call.url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(new Headers(calls[1].init.headers).get("authorization")).toBe("Bearer inst-token");
  });

  it("turns a stale save into a conflict", async () => {
    stubGithub({ "PUT /contents/docs/dma.md": () => [409, { message: "docs/dma.md does not match" }] });
    await expect(store().writeFile({ branch: "atlas/x", path: "docs/dma.md", content: "x", expectedBlobSha: "b".repeat(40), message: "m" })).rejects.toMatchObject({ status: 409 });
  });

  it("pins merges to the approved head", async () => {
    let body: Record<string, unknown> = {};
    stubGithub({
      "PUT /pulls/7/merge": (init) => {
        body = JSON.parse(String(init.body));
        return [409, { message: "Head branch was modified. Review and try the merge again." }];
      },
    });
    await expect(store().mergePullRequest({ number: 7, expectedHeadSha: "c".repeat(40), title: "t", message: "m" })).rejects.toThrow(/changed after it was approved/);
    expect(body).toMatchObject({ sha: "c".repeat(40), merge_method: "squash" });
  });
});

describe("webhook signatures", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts the right secret only", () => {
    expect(verifyGithubSignature(body, sign("s3cret"), "s3cret")).toBe(true);
    expect(verifyGithubSignature(body, sign("other"), "s3cret")).toBe(false);
    expect(verifyGithubSignature(`${body} `, sign("s3cret"), "s3cret")).toBe(false);
    expect(verifyGithubSignature(body, null, "s3cret")).toBe(false);
    expect(verifyGithubSignature(body, "sha256=abc", "s3cret")).toBe(false);
    expect(verifyGithubSignature(body, sign("s3cret"), undefined)).toBe(false);
  });
});

describe("branch names", () => {
  it("makes safe Atlas branch names from topics", () => {
    expect(branchNameFromTopic("DMA timeout proposal!")).toBe("atlas/dma-timeout-proposal");
    expect(isAtlasBranch("atlas/dma-timeout-proposal")).toBe(true);
    expect(isAtlasBranch(branchNameFromTopic("!!!"))).toBe(false);
    expect(isAtlasBranch("feature/x")).toBe(false);
  });

  it("refuses names that could escape an API path", () => {
    for (const name of ["../main", "a//b", "/main", "main/", "x.lock", "a b", ""]) expect(isReadableBranchName(name)).toBe(false);
    expect(isReadableBranchName("feature/dma_v2.1")).toBe(true);
  });
});

describe("diffs", () => {
  it("round-trips a unified patch", () => {
    const patch = unifiedPatch("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nD\ne\nf\ng\nh\ni\n");
    expect(patch).toBe("@@ -1,8 +1,9 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n h\n+i");
    const lines = parsePatch(patch);
    expect(lines.find((line) => line.kind === "removed")).toMatchObject({ text: "d", oldNumber: 4 });
    expect(lines.filter((line) => line.kind === "added").map((line) => line.newNumber)).toEqual([4, 9]);
  });

  it("is empty when nothing changed", () => {
    expect(unifiedPatch("same\n", "same\n")).toBe("");
  });
});

describe("merge policy edge cases", () => {
  const admin: Actor = { email: "lead@example.com", name: "Lead", role: "admin" };
  const approval = (email: string, headSha = "h1"): Review => ({ id: email, reviewerEmail: email, verdict: "approved", headSha, body: "", dismissed: false, createdAt: "" });
  const base = { actor: admin, status: "open" as const, authorEmail: "lead@example.com", headSha: "h1", mergeable: true, reviews: [approval("rtl@example.com")], roleOf: () => "editor" as const };

  it("lets an administrator merge their own change once someone else approved", () => {
    expect(evaluateMerge(base).allowed).toBe(true);
    expect(evaluateMerge({ ...base, reviews: [approval("lead@example.com")] }).allowed).toBe(false);
  });

  it("waits while GitHub is still computing mergeability", () => {
    expect(evaluateMerge({ ...base, mergeable: null }).reasons.join()).toMatch(/still checking/);
  });

  it("ignores approvals of an older head, and from viewers", () => {
    expect(evaluateMerge({ ...base, reviews: [approval("rtl@example.com", "h0")] }).allowed).toBe(false);
    expect(evaluateMerge({ ...base, roleOf: () => "viewer" }).allowed).toBe(false);
  });
});
