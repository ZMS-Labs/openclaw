// Memory Core plugin module implements memory_ingest behavior.
//
// Bounded FO write-back receiver (contract openclaw.memory.ingest@1). The tool
// can never hang: the indexing phase runs inside an overall deadline and the
// response always reports the honest durable state — a write whose indexing
// timed out is reported index_state=pending, never success.
import fs from "node:fs/promises";
import path from "node:path";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { Type } from "typebox";
import {
  atomicWriteFile,
  envelopePayload,
  computeContentSha256,
  INGEST_DEFAULT_INDEX_TIMEOUT_MS,
  INGEST_MAX_INDEX_TIMEOUT_MS,
  INGEST_SCHEMA_VERSION,
  loadReceipt,
  newReceiptId,
  persistReceipt,
  raceWithDeadline,
  validateIngestContent,
  type IngestIndexState,
  type IngestState,
} from "./ingest-contract.js";
import { createMemoryTool, getMemoryManagerContextWithPurpose } from "./tools.shared.js";

export const MemoryIngestSchema = Type.Object(
  {
    path: Type.String(),
    content: Type.String(),
    corpus: Type.Optional(Type.String()),
    /** Receiver-side idempotency: same key + same content returns the prior result. */
    idempotencyKey: Type.Optional(Type.String({ maxLength: 256 })),
    /** Caller-computed digest; when present it must match the receiver's hash. */
    contentSha256: Type.Optional(Type.String({ maxLength: 64 })),
    source: Type.Optional(
      Type.Object({
        artifactId: Type.Optional(Type.String({ maxLength: 256 })),
        revision: Type.Optional(Type.String({ maxLength: 128 })),
        scope: Type.Optional(Type.String({ maxLength: 256 })),
        provenance: Type.Optional(Type.String({ maxLength: 4096 })),
      }),
    ),
    /** Overall indexing deadline for this call (capped). */
    indexTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: INGEST_MAX_INDEX_TIMEOUT_MS }),
    ),
  },
  { additionalProperties: false },
);

type MemoryIngestToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
};

/**
 * Resolve the requested relative corpus path into a workspace-relative path
 * under the memory corpus, guarding against traversal outside the workspace.
 *
 * Returns the resolved absolute path plus the normalized workspace-relative
 * path, or an error string when the request escapes the corpus.
 */
function resolveCorpusTarget(params: {
  workspaceDir: string;
  requestedPath: string;
  corpus?: string;
}): { absPath: string; relPath: string } | { error: string } {
  const requested = params.requestedPath.trim().replace(/\\/g, "/");
  if (!requested) {
    return { error: "path is required" };
  }
  if (path.posix.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    return { error: "absolute paths are not allowed; path must be corpus-relative" };
  }
  if (!requested.toLowerCase().endsWith(".md")) {
    return { error: "path must end with .md (memory corpus only indexes markdown files)" };
  }
  if (requested.split("/").some((segment) => segment === "..")) {
    return { error: "path must not contain '..' segments" };
  }

  // Determine the workspace-relative path. Honor an explicit `MEMORY.md`/`memory/`
  // prefix; otherwise place the file under the requested corpus subdir
  // (defaulting to `memory/`). `corpus=root` writes relative to the workspace root.
  const corpus = (params.corpus ?? "").trim();
  let relCandidate: string;
  const isRootMemoryFile = requested === "MEMORY.md";
  const alreadyScoped = isRootMemoryFile || requested.startsWith("memory/");
  if (alreadyScoped) {
    relCandidate = requested;
  } else if (corpus === "root") {
    relCandidate = requested;
  } else {
    const subdir = corpus.length > 0 ? corpus.replace(/^\/+|\/+$/g, "") : "memory";
    relCandidate = `${subdir}/${requested}`;
  }

  const workspaceRoot = path.resolve(params.workspaceDir);
  const absPath = path.resolve(workspaceRoot, relCandidate);
  const rel = path.relative(workspaceRoot, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: "path escapes the memory corpus workspace" };
  }
  return { absPath, relPath: rel.replace(/\\/g, "/") };
}

/** Reject symlink escapes: an existing parent directory must stay under the real workspace root. */
async function assertNoSymlinkEscape(params: {
  workspaceDir: string;
  absPath: string;
}): Promise<void> {
  const rootReal = await fs.realpath(params.workspaceDir);
  const targetDirReal = await fs.realpath(path.dirname(params.absPath));
  const rel = path.relative(rootReal, targetDirReal);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("resolved path escapes the memory corpus workspace (symlink)");
  }
}

/**
 * Run the bounded index sync and exact-read verification for a corpus file.
 * Shared by every ingest outcome path so `index_state` is always earned by an
 * actual bounded sync, never assumed.
 */
async function ensureIndexed(
  manager: NonNullable<Awaited<ReturnType<typeof getMemoryManagerContextWithPurpose>>["manager"]>,
  indexTimeoutMs: number,
  absPath: string,
  body: string,
): Promise<{
  effectiveIndexState: IngestIndexState;
  verified: boolean;
  postStatus: ReturnType<typeof manager.status> | null;
}> {
  if (!manager.sync) {
    return { effectiveIndexState: "pending", verified: false, postStatus: null };
  }
  const outcome = await raceWithDeadline({
    label: "memory index sync",
    timeoutMs: indexTimeoutMs,
    operation: async () => {
      await manager.sync({ reason: "ingest" });
      return manager.status();
    },
  });
  if (outcome.timedOut) {
    return { effectiveIndexState: "pending", verified: false, postStatus: null };
  }
  const postStatus = outcome.value;
  let verified = false;
  try {
    const readBack = await fs.readFile(absPath, "utf8");
    verified = readBack === body;
  } catch {
    verified = false;
  }
  return {
    effectiveIndexState: verified ? "indexed" : "pending",
    verified,
    postStatus,
  };
}

export function createMemoryIngestTool(options: MemoryIngestToolOptions) {
  return createMemoryTool({
    options,
    label: "Memory Ingest",
    name: "memory_ingest",
    description:
      "Write a markdown document into the agent's memory corpus (MEMORY.md or memory/*.md) and index it so it becomes searchable via memory_search. `path` is the corpus-relative filename (must end in .md); a bare name is placed under `memory/` by default, `corpus=root` writes relative to the workspace root (e.g. MEMORY.md). `content` is the full markdown body to persist. Bounded receiver contract: pass `idempotencyKey` (stable per publication) and `contentSha256` for receiver-side dedupe; retries with the same key+content are no-ops, same key+different content is a conflict. Response reports `state` (WRITTEN|UPDATED|NOOP_DUPLICATE|CONFLICT|TERMINAL_FAILURE) and `index_state` (indexed|pending) — index_state=pending means the file IS durable but is not yet searchable; a later call or search-triggered sync completes indexing. If response has disabled=true, memory ingest is unavailable.",
    parameters: MemoryIngestSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const requestedPath = readStringParam(rawParams, "path", { required: true });
        // Preserve markdown whitespace exactly: do not trim the body.
        const content = readStringParam(rawParams, "content", {
          required: true,
          trim: false,
          allowEmpty: true,
        });
        const corpus = readStringParam(rawParams, "corpus");
        const idempotencyKey = readStringParam(rawParams, "idempotencyKey");
        const callerSha = readStringParam(rawParams, "contentSha256");
        const indexTimeoutRaw = rawParams["indexTimeoutMs"];
        const indexTimeoutMs =
          typeof indexTimeoutRaw === "number" && Number.isFinite(indexTimeoutRaw)
            ? Math.min(Math.max(Math.floor(indexTimeoutRaw), 100), INGEST_MAX_INDEX_TIMEOUT_MS)
            : INGEST_DEFAULT_INDEX_TIMEOUT_MS;
        const source = (rawParams["source"] ?? null) as Record<string, unknown> | null;

        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "cli",
        });
        if ("error" in memory) {
          return jsonResult({
            schema: INGEST_SCHEMA_VERSION,
            ingested: requestedPath,
            disabled: true,
            unavailable: true,
            error: memory.error ?? "memory ingest unavailable",
          });
        }

        const manager = memory.manager;
        try {
          const status = manager.status();
          const workspaceDir = status.workspaceDir;
          if (!workspaceDir) {
            return jsonResult({
              schema: INGEST_SCHEMA_VERSION,
              ingested: requestedPath,
              disabled: true,
              error: "memory workspace directory is unavailable for this agent",
            });
          }

          const target = resolveCorpusTarget({
            workspaceDir,
            requestedPath,
            corpus: corpus ?? undefined,
          });
          if ("error" in target) {
            return jsonResult({
              schema: INGEST_SCHEMA_VERSION,
              ingested: requestedPath,
              disabled: true,
              error: target.error,
            });
          }

          // VALIDATED (or terminal): UTF-8 and size bounds before any durable effect.
          const validated = validateIngestContent(content);
          if (!validated.ok) {
            return jsonResult({
              schema: INGEST_SCHEMA_VERSION,
              ingested: target.relPath,
              state: "TERMINAL_FAILURE" as IngestState,
              error: validated.error,
            });
          }

          const body = content.endsWith("\n") ? content : `${content}\n`;
          const contentSha256 = computeContentSha256(body);
          if (callerSha && callerSha !== contentSha256) {
            return jsonResult({
              schema: INGEST_SCHEMA_VERSION,
              ingested: target.relPath,
              state: "CONFLICT" as IngestState,
              error:
                "contentSha256 does not match the received content; refusing to write under a mismatched digest",
            });
          }

          // Receiver-side idempotency: durable receipts survive restarts.
          if (idempotencyKey) {
            const prior = await loadReceipt(workspaceDir, idempotencyKey);
            if (prior) {
              if (prior.content_sha256 !== contentSha256) {
                return jsonResult({
                  schema: INGEST_SCHEMA_VERSION,
                  ingested: target.relPath,
                  state: "CONFLICT" as IngestState,
                  idempotency_key: idempotencyKey,
                  prior_state: prior.state,
                  error:
                    "idempotency key was already used with different content; publication conflict",
                });
              }
              // Replay: same key, same content. Heal a pending index (a prior
              // call whose indexing timed out) instead of replaying pending
              // forever; otherwise return the prior result with attempts+1.
              let healedIndexState: IngestIndexState | null = null;
              if (prior.index_state !== "indexed") {
                const healed = await ensureIndexed(manager, indexTimeoutMs, target.absPath, body);
                healedIndexState = healed.effectiveIndexState;
              }
              // The durable receipt always tracks replay attempts, healed or
              // not, so reported attempts never drift from the stored record.
              await persistReceipt({
                workspaceDir,
                receipt: {
                  ...prior,
                  ...(healedIndexState ? { index_state: healedIndexState } : {}),
                  attempts: prior.attempts + 1,
                  updated_at: new Date().toISOString(),
                },
              });
              return jsonResult({
                ...(prior.result as Record<string, unknown>),
                schema: INGEST_SCHEMA_VERSION,
                state: "NOOP_DUPLICATE" as IngestState,
                idempotency_key: idempotencyKey,
                attempts: prior.attempts + 1,
                replayed: true,
                ...(healedIndexState ? { index_state: healedIndexState } : {}),
              });
            }
          }

          await assertNoSymlinkEscape({ workspaceDir, absPath: target.absPath });

          // Same path + same bytes: a no-op even without an idempotency key,
          // but still verify/repair the index honestly.
          let priorBytes: Buffer | null = null;
          try {
            priorBytes = await fs.readFile(target.absPath);
          } catch {
            priorBytes = null;
          }
          const isUpdate = priorBytes !== null;
          const bytesIdentical =
            priorBytes !== null && priorBytes.equals(Buffer.from(body, "utf8"));

          let written = false;
          if (!bytesIdentical) {
            // WRITTEN: durable atomic write before indexing.
            await atomicWriteFile(target.absPath, body);
            written = true;
          }

          const { effectiveIndexState, verified, postStatus } = await ensureIndexed(
            manager,
            indexTimeoutMs,
            target.absPath,
            body,
          );

          const finalState: IngestState = bytesIdentical
            ? "NOOP_DUPLICATE"
            : isUpdate
              ? "UPDATED"
              : "WRITTEN";

          const result = jsonResult({
            schema: INGEST_SCHEMA_VERSION,
            ingested: target.relPath,
            state: finalState,
            index_state: effectiveIndexState,
            verified,
            content_sha256: contentSha256,
            idempotency_key: idempotencyKey ?? null,
            source: source
              ? {
                  ...(typeof source["artifactId"] === "string"
                    ? { artifact_id: source["artifactId"] }
                    : {}),
                  ...(typeof source["revision"] === "string"
                    ? { revision: source["revision"] }
                    : {}),
                  ...(typeof source["scope"] === "string" ? { scope: source["scope"] } : {}),
                }
              : null,
            workspace_dir: workspaceDir,
            bytes: Buffer.byteLength(body, "utf-8"),
            ...(postStatus ? { files: postStatus.files, chunks: postStatus.chunks } : {}),
          });

          if (idempotencyKey) {
            await persistReceipt({
              workspaceDir,
              receipt: {
                id: newReceiptId(),
                key: idempotencyKey,
                path: target.relPath,
                content_sha256: contentSha256,
                state: finalState,
                index_state: effectiveIndexState,
                attempts: 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                result: envelopePayload(result),
              },
            });
          }

          return result;
        } finally {
          // Never let manager teardown extend the response path: on the timeout
          // branch the abandoned sync may still hold resources briefly.
          void Promise.resolve(manager.close?.()).catch(() => {});
        }
      },
  });
}
