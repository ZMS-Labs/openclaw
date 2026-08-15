// Memory Core plugin module covers memory_ingest hang reproduction and bounds.
//
// Reproduces the PR #1 stated blocker: `memory_ingest` hangs in manager.sync on a
// populated corpus. The unbounded paths under test:
//   (a) incremental sync joins an embedding backend that never responds;
//   (b) index-identity mismatch turns one ingest into a full-corpus re-embed.
// The contract these tests enforce: the tool MUST settle within a bounded
// timeout and MUST report an honest indexing state (never a silent hang, never
// success-without-index-truth).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./memory/test-runtime-mocks.js";

type EmbedBatchFn = (texts: string[]) => Promise<number[][]>;

const hoisted = vi.hoisted(() => ({
  embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])) as ReturnType<
    () => EmbedBatchFn
  > & { mockImplementation: (fn: EmbedBatchFn) => void },
}));

vi.mock("./memory/embeddings.js", () => ({
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: () => undefined,
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      maxInputTokens: 8192,
      embedQuery: async () => [0, 1, 0],
      embedBatch: hoisted.embedBatch,
    },
  }),
}));

function embedBatchMock() {
  return hoisted.embedBatch;
}

type IngestToolModule = typeof import("./tools.ingest.js");

const POPULATED_CORPUS_FILES = 120;
/** Upper bound for any single memory_ingest call. The tool must settle before this. */
const INGEST_SETTLE_BOUND_MS = 8_000;

function withSettleBound<T>(promise: Promise<T>, ms = INGEST_SETTLE_BOUND_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`memory_ingest did not settle within ${ms}ms (HANG)`), ms),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function syntheticMarkdownBody(index: number): string {
  const topic = [
    "cluster upgrades",
    "postgres failover",
    "nfs export drift",
    "flux reconciliation",
    "standing op pulse",
    "dream diary promotion",
  ][index % 6];
  return [
    `# Synthetic memory note ${index}`,
    "",
    `Topic: ${topic}. Record ${index} of the populated synthetic corpus used to`,
    "reproduce the memory_ingest hang. This body is intentionally a few hundred",
    "bytes so chunking produces realistic index work without bloating the test.",
    "",
    "Facts:",
    `- fact-${index}-a: ${topic} observed at tick ${index}.`,
    `- fact-${index}-b: remediation step ${index} recorded verbatim.`,
    `- fact-${index}-c: follow-up captured for the next cycle.`,
    "",
  ].join("\n");
}

function makeCfg(params: { workspaceDir: string; storePath: string; model?: string }) {
  return {
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        memorySearch: {
          provider: "openai",
          model: params.model ?? "mock-embed",
          store: { path: params.storePath, vector: { enabled: false } },
          chunking: { tokens: 4000, overlap: 0 },
          sync: { watch: false, onSessionStart: false, onSearch: false },
          query: { minScore: 0, hybrid: { enabled: false } },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as unknown as Parameters<IngestToolModule["createMemoryIngestTool"]>[0]["config"];
}

describe("memory_ingest populated-corpus hang boundaries", () => {
  let fixtureRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    hoisted.embedBatch.mockReset();
    hoisted.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingest-hang-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    for (let i = 0; i < POPULATED_CORPUS_FILES; i += 1) {
      await fs.writeFile(path.join(memoryDir, `note-${i}.md`), syntheticMarkdownBody(i), "utf-8");
    }
  });

  afterEach(async () => {
    const { closeAllMemorySearchManagers } = await import("./memory/index.js");
    await closeAllMemorySearchManagers();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function buildIndexFirst(storePath: string): Promise<void> {
    const { getMemorySearchManager } = await import("./memory/index.js");
    const result = await getMemorySearchManager({
      cfg: makeCfg({ workspaceDir, storePath }),
      agentId: "main",
    });
    if (!result.manager) {
      throw new Error(`bootstrap manager missing: ${result.error ?? "unknown"}`);
    }
    await result.manager.sync?.({ reason: "bootstrap" });
    const status = result.manager.status();
    expect(status.files).toBeGreaterThan(0);
    await result.manager.close?.();
  }

  async function callIngestTool(params: {
    storePath: string;
    path: string;
    content: string;
    model?: string;
  }) {
    const { createMemoryIngestTool } = await import("./tools.ingest.js");
    const tool = createMemoryIngestTool({
      config: makeCfg({ workspaceDir, storePath: params.storePath, model: params.model }),
    });
    if (!tool) {
      throw new Error("ingest tool unavailable");
    }
    const raw = await withSettleBound(
      tool.execute("ingest-hang-repro", {
        path: params.path,
        content: params.content,
      }) as Promise<unknown>,
    );
    return raw as { result?: Record<string, unknown> } & Record<string, unknown>;
  }

  it(
    "settles within the bound when the embedding backend stalls after write (populated corpus, incremental sync)",
    { timeout: 60_000 },
    async () => {
      const storePath = path.join(fixtureRoot, "index-a.sqlite");
      await buildIndexFirst(storePath);

      // Backend stalls: every subsequent embed call parks forever, as an
      // unreachable ollama/vLLM endpoint does mid-outage.
      embedBatchMock().mockImplementation(() => new Promise(() => {}));

      const raw = await callIngestTool({
        storePath,
        path: "hang-repro-incremental.md",
        content: "# Incremental ingest under a stalled backend\n\nmarker: incremental-bound",
      });

      const payload = (raw.result ?? raw) as Record<string, unknown>;
      // The tool must not claim verified indexing while the backend is stalled.
      expect(payload.synced === true && payload.indexed === true).toBe(false);
    },
  );

  it(
    "settles within the bound when provider identity mismatch forces a full re-embed (one file changed)",
    { timeout: 90_000 },
    async () => {
      const storePath = path.join(fixtureRoot, "index-b.sqlite");
      await buildIndexFirst(storePath);

      // Identity drift: the index was built by model A; this manager now claims
      // model B, so every unchanged corpus file also re-embeds.
      embedBatchMock().mockImplementation(async (texts: string[]) => {
        // Simulate a slow-but-working backend: each batch takes a fixed slice.
        await new Promise((resolve) => setTimeout(resolve, 250));
        return texts.map(() => [0, 1, 0]);
      });

      const raw = await callIngestTool({
        storePath,
        path: "hang-repro-identity.md",
        content: "# Ingest under identity-mismatch full re-embed\n\nmarker: identity-bound",
        model: "mock-embed-v2",
      });

      const payload = (raw.result ?? raw) as Record<string, unknown>;
      expect(typeof payload).toBe("object");
    },
  );
});
