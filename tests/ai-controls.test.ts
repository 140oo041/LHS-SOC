import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The switch is a constant that is off in the product. These tests turn it
// on to prove the fences behind it hold; nothing here reaches a real API.
let switchOn = false;
vi.mock("@/lib/features", () => ({ aiIntegrationEnabled: () => switchOn }));
vi.mock("@/auth", () => ({ auth: async () => null }));

const { aiOperational, aiPrerequisiteErrors } = await import("@/lib/config");
const { estimateCostMicros, recordAiUsage, reserveAiRequest } = await import("@/lib/ai-budget");
const { takeRateLimit } = await import("@/lib/rate-limit");
const { resetMemoryContent } = await import("@/lib/content");
const { createMemoryRepository } = await import("@/lib/content/memory-store");
const ingestion = await import("@/lib/ingestion");
const repository = await import("@/lib/repository");

const AI_ENV = {
  DATABASE_URL: "postgres://configured-but-unused",
  OPENAI_API_KEY: "sk-test",
  OPENAI_CHAT_MODEL: "model",
  ATLAS_AI_MONTHLY_REQUEST_LIMIT: "3",
  ATLAS_AI_MONTHLY_BUDGET_USD: "1",
  ATLAS_AI_PRICE_INPUT_PER_MTOK: "2",
  ATLAS_AI_PRICE_OUTPUT_PER_MTOK: "8",
};
const KEYS = [...Object.keys(AI_ENV), "ATLAS_AI_PRICE_FILE_SEARCH_PER_1K", "ATLAS_AI_PRICE_IMAGE_EACH"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  switchOn = false;
  globalThis.__atlasAiUsage = undefined;
  globalThis.__atlasRateLimits = undefined;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the AI gate", () => {
  it("stays shut with the switch off, whatever is configured", () => {
    Object.assign(process.env, AI_ENV);
    expect(aiOperational()).toBe(false);
  });

  it("stays shut with the switch on until spend is bounded", () => {
    switchOn = true;
    process.env.OPENAI_API_KEY = "sk-test";
    expect(aiOperational()).toBe(false);
    expect(aiPrerequisiteErrors().join("\n")).toMatch(/DATABASE_URL[\s\S]*BUDGET_USD[\s\S]*PRICE_INPUT/);
    Object.assign(process.env, AI_ENV);
    expect(aiPrerequisiteErrors()).toEqual([]);
    expect(aiOperational()).toBe(true);
  });
});

describe("spend limits (memory fallback)", () => {
  it("reserves requests up to the monthly count", async () => {
    Object.assign(process.env, AI_ENV);
    delete process.env.DATABASE_URL;
    expect([await reserveAiRequest(), await reserveAiRequest(), await reserveAiRequest(), await reserveAiRequest()]).toEqual([true, true, true, false]);
  });

  it("stops once estimated cost reaches the budget", async () => {
    Object.assign(process.env, AI_ENV);
    delete process.env.DATABASE_URL;
    process.env.ATLAS_AI_MONTHLY_REQUEST_LIMIT = "100";
    expect(await reserveAiRequest()).toBe(true);
    // 100k output tokens at $8 per million is $0.80; a second such answer crosses $1.
    await recordAiUsage("chat", "a@example.com", { outputTokens: 100_000 });
    expect(await reserveAiRequest()).toBe(true);
    await recordAiUsage("chat", "a@example.com", { outputTokens: 100_000 });
    expect(await reserveAiRequest()).toBe(false);
  });

  it("refuses everything when no budget is set", async () => {
    expect(await reserveAiRequest()).toBe(false);
  });

  it("estimates cost from tokens, tool calls, and images", () => {
    Object.assign(process.env, AI_ENV, { ATLAS_AI_PRICE_FILE_SEARCH_PER_1K: "2.5", ATLAS_AI_PRICE_IMAGE_EACH: "0.04" });
    expect(estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 500_000, toolCalls: 2, images: 1 })).toBe(2_000_000 + 4_000_000 + 5_000 + 40_000);
  });

  it("rate limits per key and window", async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await takeRateLimit("chat:a", 3, 60_000)).allowed);
    expect(results).toEqual([true, true, true, false]);
    expect((await takeRateLimit("chat:b", 3, 60_000)).allowed).toBe(true);
  });
});

describe("ingestion", () => {
  type Call = { method: string; path: string };

  function stubOpenAI() {
    const calls: Call[] = [];
    let ids = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const pathName = url.replace("https://api.openai.com/v1", "");
      const method = init.method ?? "GET";
      calls.push({ method, path: pathName });
      if (method === "POST" && pathName === "/files") return Response.json({ id: `file-${++ids}` });
      if (method === "POST" && pathName === "/vector_stores") return Response.json({ id: `vs-${++ids}` });
      if (method === "POST" && pathName.endsWith("/file_batches")) return Response.json({ id: `batch-${++ids}` });
      if (method === "GET" && pathName.includes("/file_batches/")) return Response.json({ status: "completed", file_counts: { failed: 0 } });
      if (method === "DELETE") return Response.json({ deleted: true });
      return Response.json({ error: "unrouted" }, { status: 500 });
    });
    return calls;
  }

  it("reuses unchanged files, and prunes only what no kept index uses", async () => {
    switchOn = true;
    Object.assign(process.env, AI_ENV);
    // aiPrerequisiteErrors only checks that DATABASE_URL is set; the memory
    // repository is used because hasDatabase() is mocked below.
    const db = await import("@/lib/db");
    vi.spyOn(db, "hasDatabase").mockReturnValue(false);
    globalThis.__atlasMemory = undefined;

    const repo = createMemoryRepository("main", { "docs/dma.md": "# DMA\n", "docs/boot.md": "# Boot\n" });
    resetMemoryContent(repo);
    const store = (await import("@/lib/content")).contentStore;
    const first = await (await store()).resolveHead("main");

    const calls = stubOpenAI();
    const one = await ingestion.runIngestion(first!, 5_000);
    expect(one.status).toBe("ready");
    const firstUploads = calls.filter((c) => c.method === "POST" && c.path === "/files").length;

    // Same commit again: nothing new is created.
    await ingestion.runIngestion(first!, 5_000);
    expect(calls.filter((c) => c.method === "POST" && c.path === "/vector_stores")).toHaveLength(1);

    // Change one page; only that page is uploaded again.
    const content = await store();
    await content.createBranch("atlas/edit", first!);
    const dma = (await content.listFiles(first!, "docs")).find((f) => f.path === "docs/dma.md")!;
    await content.writeFile({ branch: "atlas/edit", path: "docs/dma.md", content: "# DMA\n\nChanged.\n", expectedBlobSha: dma.blobSha, message: "m" });
    const second = await content.resolveHead("atlas/edit");
    calls.length = 0;
    const two = await ingestion.runIngestion(second!, 5_000);
    expect(two.status).toBe("ready");
    expect(calls.filter((c) => c.method === "POST" && c.path === "/files")).toHaveLength(1);
    expect(firstUploads).toBeGreaterThan(1);

    // The first index was replaced: its store is deleted, and of its files only the changed page's.
    const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes).toContain("/vector_stores/vs-1");
    expect(deletes.filter((p) => p.startsWith("/files/"))).toHaveLength(1);
    expect((await repository.latestReadyKnowledgeRevision())?.gitRevision).toBe(second);
  });

  it("refuses to start with the gate shut", async () => {
    await expect(ingestion.startIngestion("a".repeat(40))).rejects.toThrow(/no AI integration/);
  });
});
