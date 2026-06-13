// Memory Core plugin module implements memory_ingest behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { Type } from "typebox";
import { createMemoryTool, getMemoryManagerContextWithPurpose } from "./tools.shared.js";

export const MemoryIngestSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
  corpus: Type.Optional(Type.String()),
});

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
  if (!requested.toLowerCase().endsWith(".md")) {
    return { error: "path must end with .md (memory corpus only indexes markdown files)" };
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

export function createMemoryIngestTool(options: MemoryIngestToolOptions) {
  return createMemoryTool({
    options,
    label: "Memory Ingest",
    name: "memory_ingest",
    description:
      "Write a markdown document into the agent's memory corpus (MEMORY.md or memory/*.md) and re-embed it so it becomes searchable via memory_search. `path` is the corpus-relative filename (must end in .md); a bare name is placed under `memory/` by default, `corpus=root` writes relative to the workspace root (e.g. MEMORY.md). `content` is the full markdown body to persist. After writing, the memory index is synced (force reindex) using the same embedding path as `openclaw memory index`.",
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

        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "cli",
        });
        if ("error" in memory) {
          return jsonResult({
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
              ingested: requestedPath,
              disabled: true,
              error: target.error,
            });
          }

          const body = content.endsWith("\n") ? content : `${content}\n`;
          await fs.mkdir(path.dirname(target.absPath), { recursive: true });
          await fs.writeFile(target.absPath, body, "utf-8");

          let synced = false;
          if (manager.sync) {
            await manager.sync({ reason: "ingest", force: true });
            synced = true;
          }

          const postStatus = manager.status();
          return jsonResult({
            ingested: target.relPath,
            workspaceDir,
            synced,
            files: postStatus.files,
            chunks: postStatus.chunks,
            bytes: Buffer.byteLength(body, "utf-8"),
          });
        } finally {
          await manager.close?.();
        }
      },
  });
}
