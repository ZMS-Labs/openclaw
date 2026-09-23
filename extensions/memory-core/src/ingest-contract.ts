// Memory Core plugin module implements the bounded FO write-back receiver contract
// shared by memory_ingest and memory_remove.
//
// Contract version: openclaw.memory.ingest@1. Fleet Orchestrator is the sole
// sanctioned publisher; the receiver treats every payload as untrusted data and
// never as authority. Authorization for removals is enforced FO-side (operator
// gate); this receiver enforces grammar, bounds, idempotency, and honesty.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Upper bound for a single published document body. */
export const INGEST_MAX_CONTENT_BYTES = 256 * 1024;

/** Default overall deadline for the synchronous indexing phase of one call. */
export const INGEST_DEFAULT_INDEX_TIMEOUT_MS = 8_000;

/** Hard ceiling a caller may request for the indexing deadline. */
export const INGEST_MAX_INDEX_TIMEOUT_MS = 120_000;

/** Receipt-store retention: bounded, oldest-first pruning beyond this count. */
export const INGEST_RECEIPT_STORE_MAX_ENTRIES = 512;

export const INGEST_SCHEMA_VERSION = "openclaw.memory.ingest@1";

export type IngestState =
  | "RECEIVED"
  | "VALIDATED"
  | "WRITTEN"
  | "INDEX_PENDING"
  | "INDEXED"
  | "VERIFIED"
  | "NOOP_DUPLICATE"
  | "UPDATED"
  | "REMOVED"
  | "NOOP_ALREADY_ABSENT"
  | "RETRYABLE_FAILURE"
  | "TERMINAL_FAILURE"
  | "CONFLICT"
  | "QUARANTINED";

export type IngestIndexState = "unknown" | "pending" | "indexed" | "timeout" | "unavailable";

export type IngestReceipt = {
  id: string;
  key: string | null;
  path: string;
  content_sha256: string;
  state: IngestState;
  index_state: IngestIndexState;
  attempts: number;
  created_at: string;
  updated_at: string;
  result: Record<string, unknown>;
};

const RECEIPTS_FILENAME = ".ingest-receipts.json";

const receiptStoreLocks = new Map<string, Promise<unknown>>();

function lockKeyFor(storePath: string): string {
  return path.resolve(storePath);
}

/** Serialize receipt-store read-modify-write cycles per store path. */
async function withReceiptStoreLock<T>(storePath: string, run: () => Promise<T>): Promise<T> {
  const key = lockKeyFor(storePath);
  const prior = receiptStoreLocks.get(key) ?? Promise.resolve();
  const next = prior.then(run, run);
  receiptStoreLocks.set(
    key,
    next.catch(() => {}),
  );
  try {
    return await next;
  } finally {
    if (receiptStoreLocks.get(key) === next) {
      receiptStoreLocks.delete(key);
    }
  }
}

type ReceiptStore = {
  schema: typeof INGEST_SCHEMA_VERSION;
  receipts: Record<string, IngestReceipt>;
};

/**
 * Extract the plain payload object from a jsonResult envelope
 * ({content:[{type:"text",text:"<json>"}]}) so receipts store the payload
 * itself, replayable as-is, rather than the transport envelope.
 */
export function envelopePayload(envelope: unknown): Record<string, unknown> {
  const env = envelope as { content?: Array<{ type?: string; text?: string }> };
  const text = env?.content?.find((part) => part?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      // fall through to the raw value
    }
  }
  return (envelope as Record<string, unknown>) ?? {};
}

export function computeContentSha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function newReceiptId(): string {
  return randomBytes(12).toString("hex");
}

/** Reject lone surrogates so the persisted corpus is always valid UTF-8. */
export function isValidUtf8Text(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function receiptsStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", RECEIPTS_FILENAME);
}

export async function loadReceipt(
  workspaceDir: string,
  key: string,
): Promise<IngestReceipt | null> {
  const storePath = receiptsStorePath(workspaceDir);
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as ReceiptStore;
    return parsed.receipts[key] ?? null;
  } catch {
    return null;
  }
}

export async function persistReceipt(params: {
  workspaceDir: string;
  receipt: IngestReceipt;
}): Promise<void> {
  const storePath = receiptsStorePath(params.workspaceDir);
  await withReceiptStoreLock(storePath, async () => {
    let store: ReceiptStore = { schema: INGEST_SCHEMA_VERSION, receipts: {} };
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as ReceiptStore;
      if (parsed && typeof parsed === "object" && parsed.receipts) {
        store = parsed;
      }
    } catch {
      // Missing or corrupt store: start fresh rather than failing the write path.
    }
    const key = params.receipt.key ?? `path:${params.receipt.path}`;
    const prior = store.receipts[key];
    const merged: IngestReceipt = prior
      ? {
          ...prior,
          ...params.receipt,
          // Immutable provenance: creation facts never rewrite on retry.
          // attempts is the caller's absolute monotonic count; max() keeps it
          // monotonic even under a lost-update race between two writers.
          created_at: prior.created_at,
          attempts: Math.max(prior.attempts, params.receipt.attempts || 0),
        }
      : params.receipt;
    store.receipts[key] = merged;
    pruneReceiptStore(store);
    await atomicWriteFile(storePath, JSON.stringify(store, null, 2) + "\n");
  });
}

function pruneReceiptStore(store: ReceiptStore): void {
  const entries = Object.values(store.receipts);
  if (entries.length <= INGEST_RECEIPT_STORE_MAX_ENTRIES) {
    return;
  }
  const sorted = [...entries].sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1));
  const excess = sorted.length - INGEST_RECEIPT_STORE_MAX_ENTRIES;
  for (const victim of sorted.slice(0, excess)) {
    delete store.receipts[victim.key ?? `path:${victim.path}`];
  }
}

/** Write bytes durably: temp file in the same directory, flush, atomic rename. */
export async function atomicWriteFile(absPath: string, body: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(absPath)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  const handle = await fs.open(tmpPath, "w");
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Race an operation against a deadline. Returns `{ timedOut: true }` when the
 * bound is exceeded — the operation promise itself is abandoned (never awaited
 * by the caller), which is what makes the ingest tool unable to hang even when
 * the embedding backend parks forever and ignores the abort signal.
 */
export async function raceWithDeadline<T>(params: {
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  label: string;
}): Promise<{ timedOut: false; value: T } | { timedOut: true; label: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${params.label} exceeded ${params.timeoutMs}ms deadline`));
    }, params.timeoutMs);
  });
  try {
    const value = await Promise.race([params.operation(controller.signal), deadline]);
    return { timedOut: false as const, value };
  } catch (err) {
    if (controller.signal.aborted) {
      return { timedOut: true as const, label: params.label };
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function validateIngestContent(
  content: string,
): { ok: true } | { ok: false; error: string } {
  if (!isValidUtf8Text(content)) {
    return { ok: false, error: "content is not valid UTF-8 (lone surrogate)" };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > INGEST_MAX_CONTENT_BYTES) {
    return {
      ok: false,
      error: `content exceeds ${INGEST_MAX_CONTENT_BYTES} bytes (got ${bytes})`,
    };
  }
  return { ok: true };
}
