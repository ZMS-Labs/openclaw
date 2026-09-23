// Memory Core plugin module implements memory_remove behavior.
//
// Operator-gated correction path of the FO write-back receiver (contract
// openclaw.memory.ingest@1). Authorization is enforced Fleet-Orchestrator-side
// (operator approval before FO issues the call); this receiver enforces
// grammar, bounds, idempotency, and honest states. Removal is restricted to
// corpus-relative markdown paths — no broad recursive deletion exists.
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
  computeContentSha256,
  envelopePayload,
  INGEST_DEFAULT_INDEX_TIMEOUT_MS,
  INGEST_MAX_INDEX_TIMEOUT_MS,
  INGEST_SCHEMA_VERSION,
  loadReceipt,
  newReceiptId,
  persistReceipt,
  raceWithDeadline,
  type IngestIndexState,
  type IngestState,
} from "./ingest-contract.js";
import { createMemoryTool, getMemoryManagerContextWithPurpose } from "./tools.shared.js";

export const MemoryRemoveSchema = Type.Object(
  {
    path: Type.String(),
    corpus: Type.Optional(Type.String()),
    idempotencyKey: Type.Optional(Type.String({ maxLength: 256 })),
    reason: Type.Optional(Type.String({ maxLength: 1024 })),
    indexTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 100, maximum: INGEST_MAX_INDEX_TIMEOUT_MS }),
    ),
  },
  { additionalProperties: false },
);

type MemoryRemoveToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
};

function resolveRemoveTarget(params: {
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
    return { error: "path must end with .md (memory corpus only holds markdown files)" };
  }
  if (requested.split("/").some((segment) => segment === "..")) {
    return { error: "path must not contain '..' segments" };
  }
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
  if (rel.replace(/\\/g, "/") === "memory/.ingest-receipts.json") {
    return { error: "refusing to remove the receiver receipt store" };
  }
  return { absPath, relPath: rel.replace(/\\/g, "/") };
}

export function createMemoryRemoveTool(options: MemoryRemoveToolOptions) {
  return createMemoryTool({
    options,
    label: "Memory Remove",
    name: "memory_remove",
    description:
      "Remove one markdown document from the agent's memory corpus (corpus-relative `.md` path, same grammar as memory_ingest) and drop it from the index. Operator-gated: Fleet Orchestrator issues this call only after operator approval; callers cannot broaden it (single file per call, no recursion, receipt store protected). Idempotent: removing an absent path reports NOOP_ALREADY_ABSENT. Receipts are preserved as audit. Response reports state (REMOVED|NOOP_ALREADY_ABSENT|TERMINAL_FAILURE) and index_state (indexed|pending).",
    parameters: MemoryRemoveSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const requestedPath = readStringParam(rawParams, "path", { required: true });
        const corpus = readStringParam(rawParams, "corpus");
        const idempotencyKey = readStringParam(rawParams, "idempotencyKey");
        const reason = readStringParam(rawParams, "reason");
        const indexTimeoutRaw = rawParams["indexTimeoutMs"];
        const indexTimeoutMs =
          typeof indexTimeoutRaw === "number" && Number.isFinite(indexTimeoutRaw)
            ? Math.min(Math.max(Math.floor(indexTimeoutRaw), 100), INGEST_MAX_INDEX_TIMEOUT_MS)
            : INGEST_DEFAULT_INDEX_TIMEOUT_MS;

        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "cli",
        });
        if ("error" in memory) {
          return jsonResult({
            schema: INGEST_SCHEMA_VERSION,
            removed: requestedPath,
            disabled: true,
            unavailable: true,
            error: memory.error ?? "memory remove unavailable",
          });
        }

        const manager = memory.manager;
        try {
          const status = manager.status();
          const workspaceDir = status.workspaceDir;
          if (!workspaceDir) {
            return jsonResult({
              schema: INGEST_SCHEMA_VERSION,
              removed: requestedPath,
              disabled: true,
              error: "memory workspace directory is unavailable for this agent",
            });
          }

          const target = resolveRemoveTarget({
            workspaceDir,
            requestedPath,
            corpus: corpus ?? undefined,
          });
          if ("error" in target) {
            return jsonResult({
              schema: INGEST_SCHEMA_VERSION,
              removed: requestedPath,
              disabled: true,
              error: target.error,
            });
          }

          if (idempotencyKey) {
            const prior = await loadReceipt(workspaceDir, idempotencyKey);
            if (
              prior &&
              prior.path === target.relPath &&
              (prior.state === "REMOVED" || prior.state === "NOOP_ALREADY_ABSENT")
            ) {
              return jsonResult({
                ...(prior.result as Record<string, unknown>),
                schema: INGEST_SCHEMA_VERSION,
                replayed: true,
                attempts: prior.attempts + 1,
              });
            }
          }

          let existed = false;
          let priorSha: string | null = null;
          try {
            const priorBytes = await fs.readFile(target.absPath);
            existed = true;
            priorSha = computeContentSha256(priorBytes.toString("utf8"));
            await fs.unlink(target.absPath);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== "ENOENT") {
              return jsonResult({
                schema: INGEST_SCHEMA_VERSION,
                removed: target.relPath,
                state: "RETRYABLE_FAILURE" as IngestState,
                error: `failed to remove file: ${String(err)}`,
              });
            }
          }

          let effectiveIndexState: IngestIndexState = "pending";
          let postStatus: ReturnType<typeof manager.status> | null = null;
          if (manager.sync) {
            const outcome = await raceWithDeadline({
              label: "memory index sync (remove)",
              timeoutMs: indexTimeoutMs,
              operation: async () => {
                await manager.sync({ reason: "remove" });
                return manager.status();
              },
            });
            if (!outcome.timedOut) {
              postStatus = outcome.value;
              effectiveIndexState = "indexed";
            }
          }

          const finalState: IngestState = existed ? "REMOVED" : "NOOP_ALREADY_ABSENT";
          const result = jsonResult({
            schema: INGEST_SCHEMA_VERSION,
            removed: target.relPath,
            state: finalState,
            index_state: effectiveIndexState,
            prior_content_sha256: priorSha,
            reason: reason ?? null,
            idempotency_key: idempotencyKey ?? null,
            ...(postStatus ? { files: postStatus.files, chunks: postStatus.chunks } : {}),
          });

          if (idempotencyKey) {
            await persistReceipt({
              workspaceDir,
              receipt: {
                id: newReceiptId(),
                key: idempotencyKey,
                path: target.relPath,
                content_sha256: priorSha ?? "",
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
          void Promise.resolve(manager.close?.()).catch(() => {});
        }
      },
  });
}
