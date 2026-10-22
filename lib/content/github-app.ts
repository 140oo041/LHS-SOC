import { createPrivateKey, createSign } from "node:crypto";
import { ContentConflictError, ContentNotFoundError, ContentRefusedError } from "@/lib/content/types";

/**
 * Authentication as the Atlas GitHub App.
 *
 * Plain fetch and node:crypto rather than Octokit: Atlas needs a dozen REST
 * calls, and signing a JWT is a few lines. The App signs a short-lived JWT
 * with its private key and trades it for an installation token, which is
 * scoped to this one repository and cached until shortly before it expires.
 */

export type GithubSettings = {
  appId: string;
  privateKey: string;
  installationId: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  apiBase: string;
};

const SETTINGS_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID", "GITHUB_REPOSITORY"] as const;

export function githubConfigured(env: Record<string, string | undefined> = process.env) {
  return SETTINGS_KEYS.every((key) => Boolean(env[key]));
}

/** Accepts the PEM as-is, with escaped newlines, or base64-encoded. */
export function decodePrivateKey(value: string) {
  const text = value.includes("BEGIN") ? value.replace(/\\n/g, "\n") : Buffer.from(value, "base64").toString("utf8");
  return text.trim();
}

/** What is wrong with the GitHub settings, for lib/config's report. */
export function githubConfigurationErrors(env: Record<string, string | undefined> = process.env): string[] {
  const present = SETTINGS_KEYS.filter((key) => Boolean(env[key]));
  if (!present.length) return [];
  const errors: string[] = [];
  const missing = SETTINGS_KEYS.filter((key) => !env[key]);
  if (missing.length) errors.push(`The wiki's GitHub connection is half-configured: ${missing.join(", ")} missing.`);
  if (env.GITHUB_REPOSITORY && !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) {
    errors.push("GITHUB_REPOSITORY must look like owner/repo.");
  }
  if (env.GITHUB_APP_PRIVATE_KEY) {
    try {
      createPrivateKey(decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY));
    } catch {
      errors.push("GITHUB_APP_PRIVATE_KEY is not a readable private key. Paste the PEM, or base64-encode it.");
    }
  }
  if (!missing.length && !env.GITHUB_WEBHOOK_SECRET) {
    errors.push("GITHUB_WEBHOOK_SECRET is missing, so Atlas cannot see pushes made outside it.");
  }
  return errors;
}

export function githubSettings(env: Record<string, string | undefined> = process.env): GithubSettings {
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
  return {
    appId: env.GITHUB_APP_ID ?? "",
    privateKey: decodePrivateKey(env.GITHUB_APP_PRIVATE_KEY ?? ""),
    installationId: env.GITHUB_APP_INSTALLATION_ID ?? "",
    owner,
    repo,
    defaultBranch: env.GITHUB_DEFAULT_BRANCH || "main",
    apiBase: env.GITHUB_API_URL || "https://api.github.com",
  };
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** The App's own identity, valid for nine minutes. */
export function appJwt(settings: Pick<GithubSettings, "appId" | "privateKey">, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdated a minute to tolerate clock drift between this host and GitHub.
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: settings.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64url(signer.sign(createPrivateKey(settings.privateKey)))}`;
}

let cachedToken: { token: string; expiresAt: number; key: string } | null = null;

export function resetInstallationTokenForTests() {
  cachedToken = null;
}

async function installationToken(settings: GithubSettings) {
  const key = `${settings.appId}:${settings.installationId}`;
  if (cachedToken && cachedToken.key === key && cachedToken.expiresAt - 5 * 60_000 > Date.now()) return cachedToken.token;
  const response = await fetch(`${settings.apiBase}/app/installations/${settings.installationId}/access_tokens`, {
    method: "POST",
    headers: { ...baseHeaders(), Authorization: `Bearer ${appJwt(settings)}` },
    body: JSON.stringify({ repositories: [settings.repo], permissions: { contents: "write", pull_requests: "write", metadata: "read" } }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub refused the Atlas App's credentials (${response.status})`);
  const data = (await response.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, expiresAt: Date.parse(data.expires_at), key };
  return data.token;
}

function baseHeaders() {
  return { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
}

/**
 * One authenticated REST call against the configured repository. `path` is
 * relative to /repos/{owner}/{repo}. GitHub's status codes are mapped onto
 * the content errors the rest of Atlas understands.
 */
export async function github<T>(settings: GithubSettings, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await installationToken(settings);
  const response = await fetch(`${settings.apiBase}/repos/${settings.owner}/${settings.repo}${path}`, {
    method: init.method ?? "GET",
    headers: { ...baseHeaders(), Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    // Freshness is decided by lib/content's caches, keyed by sha, not by
    // fetch's; the token in the header would split fetch's cache keys anyway.
    cache: "no-store",
  });
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (response.ok) return data as T;

  const message = (data as { message?: string } | undefined)?.message ?? `GitHub answered ${response.status}`;
  if (response.status === 404) throw new ContentNotFoundError(message);
  if (response.status === 409) throw new ContentConflictError(message);
  if (response.status === 405 || response.status === 422) throw new ContentRefusedError(message);
  throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status}): ${message}`);
}
