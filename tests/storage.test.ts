import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDownloadUrl, createUploadTarget } from "@/lib/storage";

const GUARDED = ["S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SSE"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(GUARDED.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    S3_BUCKET: "atlas-docs",
    S3_REGION: "auto",
    S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
  });
  delete process.env.S3_SSE;
});

afterEach(() => {
  for (const key of GUARDED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("presigned storage links", () => {
  it("signs an upload the browser can send with only a Content-Type header", async () => {
    const target = await createUploadTarget("coral/documents/new/id.pdf", "application/pdf", "/local");
    const url = new URL(target.url);
    expect(url.host).toBe("account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/atlas-docs/coral/documents/new/id.pdf");
    // A checksum the browser does not compute would make every upload fail.
    expect([...url.searchParams.keys()].some((key) => /checksum/i.test(key))).toBe(false);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(600);
    expect(target.headers).toEqual({ "Content-Type": "application/pdf" });
  });

  it("asks for server-side encryption only when configured", async () => {
    process.env.S3_SSE = "AES256";
    const target = await createUploadTarget("k.pdf", "application/pdf", "/local");
    expect(target.headers["x-amz-server-side-encryption"]).toBe("AES256");
  });

  it("gives downloads a one-minute life and the original filename", async () => {
    const url = new URL((await createDownloadUrl("k.pdf", "DMA spec.pdf", "application/pdf"))!);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("response-content-disposition")).toContain("DMA%20spec.pdf");
  });

  it("falls back to Atlas routes without a bucket", async () => {
    delete process.env.S3_BUCKET;
    expect(await createUploadTarget("k.pdf", "application/pdf", "/local")).toMatchObject({ url: "/local" });
    expect(await createDownloadUrl("k.pdf", "k.pdf", "application/pdf")).toBeNull();
  });
});
