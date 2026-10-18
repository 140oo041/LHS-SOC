import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configurationErrors,
  demoAuthEnabled,
  isLocalDevelopment,
  publicErrorMessage,
  secretMatches,
} from "@/lib/config";

const GUARDED = [
  "NODE_ENV",
  "ATLAS_DEMO_AUTH",
  "AUTH_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "ATLAS_ALLOWED_EMAIL_DOMAINS",
] as const;

// NODE_ENV is declared read-only on ProcessEnv, and these tests exist
// precisely to vary it.
const env = process.env as Record<string, string | undefined>;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(GUARDED.map((key) => [key, env[key]]));
});

afterEach(() => {
  for (const key of GUARDED) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function setEnv(values: Partial<Record<(typeof GUARDED)[number], string | undefined>>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

/**
 * These assertions exist because the original code expressed every
 * development convenience as `NODE_ENV !== "production"`, which grants the
 * convenience whenever the variable is absent or misspelled. A deployment is
 * far more likely to lose NODE_ENV than to set it to "development", so the
 * default must be the strict posture.
 */
describe("deployment posture defaults to hardened", () => {
  it("treats a blank environment as a deployment, not as local development", () => {
    setEnv({ NODE_ENV: undefined });
    expect(isLocalDevelopment()).toBe(false);
  });

  it("treats an unexpected NODE_ENV as a deployment", () => {
    setEnv({ NODE_ENV: "prod" });
    expect(isLocalDevelopment()).toBe(false);
    setEnv({ NODE_ENV: "staging" });
    expect(isLocalDevelopment()).toBe(false);
  });

  it("only recognizes the value next dev sets", () => {
    setEnv({ NODE_ENV: "development" });
    expect(isLocalDevelopment()).toBe(true);
  });
});

describe("the demo actor is opt-in", () => {
  it("stays closed when NODE_ENV is missing even if the flag is set", () => {
    setEnv({ NODE_ENV: undefined, ATLAS_DEMO_AUTH: "true" });
    expect(demoAuthEnabled()).toBe(false);
  });

  it("stays closed in development unless explicitly requested", () => {
    setEnv({ NODE_ENV: "development", ATLAS_DEMO_AUTH: undefined });
    expect(demoAuthEnabled()).toBe(false);
  });

  it("opens only for an explicit flag in development", () => {
    setEnv({ NODE_ENV: "development", ATLAS_DEMO_AUTH: "true" });
    expect(demoAuthEnabled()).toBe(true);
  });
});

describe("upstream error text", () => {
  const error = new Error("OpenAI request failed (401): Incorrect API key sk-proj-abc123");

  it("never reaches a caller outside local development", () => {
    setEnv({ NODE_ENV: undefined });
    expect(publicErrorMessage(error, "Atlas could not answer.")).toBe("Atlas could not answer.");
  });

  it("is available while developing locally", () => {
    setEnv({ NODE_ENV: "development" });
    expect(publicErrorMessage(error, "Atlas could not answer.")).toContain("401");
  });
});

describe("machine secret comparison", () => {
  it("accepts an exact match", () => {
    expect(secretMatches("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects a mismatch, a prefix, and a length difference", () => {
    expect(secretMatches("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(secretMatches("s3cret", "s3cret-value")).toBe(false);
    expect(secretMatches("s3cret-value-and-more", "s3cret-value")).toBe(false);
  });

  it("rejects a missing header or a missing configured secret", () => {
    expect(secretMatches(null, "s3cret-value")).toBe(false);
    expect(secretMatches("s3cret-value", undefined)).toBe(false);
    expect(secretMatches(null, undefined)).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });
});

describe("configuration report", () => {
  it("names every missing prerequisite for a deployment", () => {
    setEnv({
      NODE_ENV: undefined,
      AUTH_SECRET: undefined,
      AUTH_GOOGLE_ID: undefined,
      AUTH_GOOGLE_SECRET: undefined,
      ATLAS_ALLOWED_EMAIL_DOMAINS: undefined,
    });
    const errors = configurationErrors();
    expect(errors).toHaveLength(3);
    expect(errors.join("\n")).toContain("AUTH_SECRET");
    expect(errors.join("\n")).toContain("identity provider");
    expect(errors.join("\n")).toContain("ATLAS_ALLOWED_EMAIL_DOMAINS");
  });

  it("is silent once a deployment is fully configured", () => {
    setEnv({
      NODE_ENV: undefined,
      AUTH_SECRET: "generated-secret",
      AUTH_GOOGLE_ID: "client-id",
      AUTH_GOOGLE_SECRET: "client-secret",
      ATLAS_ALLOWED_EMAIL_DOMAINS: "example.com",
      ATLAS_DEMO_AUTH: undefined,
    });
    expect(configurationErrors()).toEqual([]);
  });

  it("refuses a deployment that leaves the demo actor enabled", () => {
    setEnv({
      NODE_ENV: undefined,
      AUTH_SECRET: "generated-secret",
      AUTH_GOOGLE_ID: "client-id",
      AUTH_GOOGLE_SECRET: "client-secret",
      ATLAS_ALLOWED_EMAIL_DOMAINS: "example.com",
      ATLAS_DEMO_AUTH: "true",
    });
    expect(configurationErrors().join("\n")).toContain("ATLAS_DEMO_AUTH");
  });

  it("reports nothing while developing locally", () => {
    setEnv({ NODE_ENV: "development", AUTH_SECRET: undefined });
    expect(configurationErrors()).toEqual([]);
  });
});
