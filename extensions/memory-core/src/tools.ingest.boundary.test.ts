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

function unwrapToolJson(raw: unknown): Record<string, unknown> {
  const envelope = raw as { content?: Array<{ type?: string; text?: string }> };
  const text = envelope?.content?.find((part) => part.type === "text")?.text;
  if (typeof text === "string") {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return (raw as { result?: Record<string, unknown> }).result ?? (raw as Record<string, unknown>);
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
    await closeAllMemorySearchManagers().catch(() => {});
    // Best-effort cleanup: an abandoned-in-timeout manager may briefly hold the
    // sqlite file on Windows; retry, then leave the temp artifact behind.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rm(fixtureRoot, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
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
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        ...(params.contentSha256 ? { contentSha256: params.contentSha256 } : {}),
        ...(params.indexTimeoutMs ? { indexTimeoutMs: params.indexTimeoutMs } : {}),
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
        indexTimeoutMs: 2_000,
      });

      const payload = unwrapToolJson(raw);
      // The file IS durable; indexing is honestly pending, never claimed done.
      expect(payload.state).toBe("WRITTEN");
      expect(payload.index_state).toBe("pending");
      expect(payload.verified).toBe(false);
      const onDisk = await fs.readFile(
        path.join(workspaceDir, "memory", "hang-repro-incremental.md"),
        "utf8",
      );
      expect(onDisk).toContain("marker: incremental-bound");
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

      const payload = unwrapToolJson(raw);
      expect(typeof payload).toBe("object");
    },
  );
});

describe("memory_ingest receiver contract: idempotency, conflict, update, removal", () => {
  let fixtureRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    hoisted.embedBatch.mockReset();
    hoisted.embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => [0, 1, 0]));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingest-contract-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "seed.md"),
      "# Seed\n\nseed content\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    const { closeAllMemorySearchManagers } = await import("./memory/index.js");
    await closeAllMemorySearchManagers().catch(() => {});
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  });

  function contractCfg() {
    return {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: {
              path: path.join(fixtureRoot, "contract.sqlite"),
              vector: { enabled: false },
            },
            chunking: { tokens: 4000, overlap: 0 },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as never;
  }

  async function ingest(params: Record<string, unknown>) {
    const { createMemoryIngestTool } = await import("./tools.ingest.js");
    const tool = createMemoryIngestTool({ config: contractCfg() });
    if (!tool) {
      throw new Error("ingest tool unavailable");
    }
    return unwrapToolJson(await (tool.execute("contract", params) as Promise<unknown>));
  }

  async function remove(params: Record<string, unknown>) {
    const { createMemoryRemoveTool } = await import("./tools.remove.js");
    const tool = createMemoryRemoveTool({ config: contractCfg() });
    if (!tool) {
      throw new Error("remove tool unavailable");
    }
    return unwrapToolJson(await (tool.execute("contract-remove", params) as Promise<unknown>));
  }

  it(
    "same idempotency key + same content replays the prior result without a second write",
    { timeout: 30_000 },
    async () => {
      const first = await ingest({
        path: "idem.md",
        content: "# Idem\n\nfirst body\n",
        idempotencyKey: "pub-001",
      });
      expect(first.state).toBe("WRITTEN");
      expect(first.index_state).toBe("indexed");
      expect(first.verified).toBe(true);

      const receiptsRaw = await fs.readFile(
        path.join(workspaceDir, "memory", ".ingest-receipts.json"),
        "utf8",
      );
      const receiptsBefore = JSON.parse(receiptsRaw).receipts as Record<
        string,
        { attempts: number }
      >;

      const second = await ingest({
        path: "idem.md",
        content: "# Idem\n\nfirst body\n",
        idempotencyKey: "pub-001",
      });
      expect(second.state).toBe("NOOP_DUPLICATE");
      expect(second.replayed).toBe(true);
      expect(second.attempts).toBe(2);
      // No duplicate durable memory: file content unchanged, one file only.
      const onDisk = await fs.readFile(path.join(workspaceDir, "memory", "idem.md"), "utf8");
      expect(onDisk).toContain("first body");
      const receiptsAfter = JSON.parse(
        await fs.readFile(path.join(workspaceDir, "memory", ".ingest-receipts.json"), "utf8"),
      ).receipts as Record<string, { attempts: number }>;
      expect(receiptsAfter["pub-001"].attempts).toBe(receiptsBefore["pub-001"].attempts + 1);
    },
  );

  it("same idempotency key + different content is a CONFLICT", { timeout: 30_000 }, async () => {
    await ingest({ path: "idem-c.md", content: "# C\n\noriginal\n", idempotencyKey: "pub-002" });
    const clash = await ingest({
      path: "idem-c.md",
      content: "# C\n\nmutated payload\n",
      idempotencyKey: "pub-002",
    });
    expect(clash.state).toBe("CONFLICT");
    // The conflicting payload must NOT have overwritten the original.
    const onDisk = await fs.readFile(path.join(workspaceDir, "memory", "idem-c.md"), "utf8");
    expect(onDisk).toContain("original");
  });

  it("mismatched contentSha256 is refused before any write", { timeout: 30_000 }, async () => {
    const res = await ingest({
      path: "sha-guard.md",
      content: "# Sha\n\nbody\n",
      contentSha256: "deadbeef",
    });
    expect(res.state).toBe("CONFLICT");
    await expect(fs.readFile(path.join(workspaceDir, "memory", "sha-guard.md"))).rejects.toThrow();
  });

  it("same path with changed content is an explicit UPDATE", { timeout: 30_000 }, async () => {
    await ingest({ path: "upd.md", content: "# Upd\n\nv1\n" });
    const second = await ingest({ path: "upd.md", content: "# Upd\n\nv2 with new facts\n" });
    expect(second.state).toBe("UPDATED");
    expect(second.index_state).toBe("indexed");
    const onDisk = await fs.readFile(path.join(workspaceDir, "memory", "upd.md"), "utf8");
    expect(onDisk).toContain("v2 with new facts");
  });

  it("rejects absolute paths, non-markdown paths, and traversal", { timeout: 30_000 }, async () => {
    const abs = await ingest({ path: "/etc/passwd.md", content: "x\n" });
    expect(abs.disabled).toBe(true);
    const txt = await ingest({ path: "notes.txt", content: "x\n" });
    expect(txt.disabled).toBe(true);
    const trav = await ingest({ path: "../escape.md", content: "x\n" });
    expect(trav.disabled).toBe(true);
  });

  it(
    "rejects invalid UTF-8 and oversized content before any durable effect",
    { timeout: 30_000 },
    async () => {
      const badUtf8 = await ingest({ path: "surrogate.md", content: "bad \ud800 surrogate" });
      expect(badUtf8.state).toBe("TERMINAL_FAILURE");
      const oversize = await ingest({ path: "big.md", content: "x".repeat(256 * 1024 + 1) });
      expect(oversize.state).toBe("TERMINAL_FAILURE");
    },
  );

  it(
    "memory_remove removes, is idempotent, protects receipts, and leaves other memory intact",
    { timeout: 30_000 },
    async () => {
      await ingest({ path: "victim.md", content: "# Victim\n\nremove me\n" });
      const removed = await remove({ path: "victim.md", idempotencyKey: "rm-001" });
      expect(removed.state).toBe("REMOVED");
      await expect(fs.readFile(path.join(workspaceDir, "memory", "victim.md"))).rejects.toThrow();

      const again = await remove({ path: "victim.md", idempotencyKey: "rm-001" });
      expect(["REMOVED", "NOOP_ALREADY_ABSENT"]).toContain(again.state);

      const absent = await remove({ path: "never-existed.md" });
      expect(absent.state).toBe("NOOP_ALREADY_ABSENT");

      // Seed memory and the receipt store survive.
      const seed = await fs.readFile(path.join(workspaceDir, "memory", "seed.md"), "utf8");
      expect(seed).toContain("seed content");
      const receipts = await fs.readFile(
        path.join(workspaceDir, "memory", ".ingest-receipts.json"),
        "utf8",
      );
      expect(JSON.parse(receipts).receipts["rm-001"].state).toBe("REMOVED");

      const guard = await remove({ path: ".ingest-receipts.json" });
      expect(guard.disabled).toBe(true);
    },
  );
});
