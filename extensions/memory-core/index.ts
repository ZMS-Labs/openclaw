// Memory Core plugin entrypoint registers its OpenClaw integration.
import {
  jsonResult,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryPluginRuntime,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  definePluginEntry,
  type AnyAgentTool,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { TSchema } from "typebox";
import { configureMemoryCoreDreamingState } from "./src/dreaming-state.js";
import { registerShortTermPromotionDreaming } from "./src/dreaming.js";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./src/memory/provider-adapters.js";
import { buildPromptSection } from "./src/prompt-section.js";

type MemoryToolsModule = typeof import("./src/tools.js");
type RuntimeProviderModule = typeof import("./src/runtime-provider.js");

type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
};

let memoryToolsModulePromise: Promise<MemoryToolsModule> | undefined;
let runtimeProviderModulePromise: Promise<RuntimeProviderModule> | undefined;

function loadMemoryToolsModule(): Promise<MemoryToolsModule> {
  memoryToolsModulePromise ??= import("./src/tools.js");
  return memoryToolsModulePromise;
}

function loadRuntimeProviderModule(): Promise<RuntimeProviderModule> {
  runtimeProviderModulePromise ??= import("./src/runtime-provider.js");
  return runtimeProviderModulePromise;
}

function getToolConfig(options: MemoryToolOptions): OpenClawConfig | undefined {
  return options.getConfig?.() ?? options.config;
}

function hasMemoryToolContext(options: MemoryToolOptions): boolean {
  const cfg = getToolConfig(options);
  if (!cfg) {
    return false;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  return Boolean(resolveMemorySearchConfig(cfg, agentId));
}

const MemorySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "integer", minimum: 1 },
    minScore: { type: "number" },
    corpus: { type: "string", enum: ["memory", "wiki", "all", "sessions"] },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryGetSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
    corpus: { type: "string", enum: ["memory", "wiki", "all"] },
  },
  required: ["path"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryIngestSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    content: { type: "string" },
    corpus: { type: "string" },
  },
  required: ["path", "content"],
  additionalProperties: false,
} as const satisfies TSchema;

const DreamSchema = {
  type: "object",
  properties: {
    phase: { type: "string", enum: ["all", "light", "rem", "deep"] },
    scope: { type: "string" },
  },
  additionalProperties: false,
} as const satisfies TSchema;

function createLazyMemoryTool(params: {
  options: MemoryToolOptions;
  label: string;
  name: string;
  description: string;
  parameters: TSchema;
  unavailableError?: string;
  load: (options: MemoryToolOptions) => Promise<AnyAgentTool | null>;
}): AnyAgentTool | null {
  if (!hasMemoryToolContext(params.options)) {
    return null;
  }

  let toolPromise: Promise<AnyAgentTool | null> | undefined;
  const loadTool = async () => {
    toolPromise ??= params.load(params.options);
    return await toolPromise;
  };

  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: async (toolCallId, toolParams, signal, onUpdate) => {
      const tool = await loadTool();
      if (!tool) {
        return jsonResult({
          disabled: true,
          unavailable: true,
          error: params.unavailableError ?? "memory search unavailable",
        });
      }
      return await tool.execute(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

function createLazyMemorySearchTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional `corpus=wiki` or `corpus=all` also searches registered compiled-wiki supplements. `corpus=memory` restricts hits to indexed memory files (excludes session transcript chunks from ranking). `corpus=sessions` restricts hits to indexed session transcripts (same visibility rules as session history tools). If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    parameters: MemorySearchSchema,
    load: async (loadOptions) => {
      const module = await loadMemoryToolsModule();
      return module.createMemorySearchTool(loadOptions);
    },
  });
}

function createLazyMemoryGetTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe exact excerpt read from MEMORY.md or memory/*.md. Defaults to a bounded excerpt when lines are omitted, includes truncation/continuation info when more content exists, and `corpus=wiki` reads from registered compiled-wiki supplements.",
    parameters: MemoryGetSchema,
    load: async (loadOptions) => {
      const module = await loadMemoryToolsModule();
      return module.createMemoryGetTool(loadOptions);
    },
  });
}

function createLazyMemoryIngestTool(options: MemoryToolOptions): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    label: "Memory Ingest",
    name: "memory_ingest",
    description:
      "Write a markdown document into the agent's memory corpus (MEMORY.md or memory/*.md) and re-embed it so it becomes searchable via memory_search. `path` is the corpus-relative filename (must end in .md); a bare name is placed under `memory/` by default, `corpus=root` writes relative to the workspace root (e.g. MEMORY.md). `content` is the full markdown body to persist. After writing, the memory index is synced (force reindex) using the same embedding path as `openclaw memory index`. If response has disabled=true, memory ingest is unavailable.",
    parameters: MemoryIngestSchema,
    unavailableError: "memory ingest unavailable",
    load: async (loadOptions) => {
      const { createMemoryIngestTool } = await import("./src/tools.ingest.js");
      return createMemoryIngestTool(loadOptions);
    },
  });
}

function createLazyDreamTool(
  api: OpenClawPluginApi,
  options: MemoryToolOptions,
): AnyAgentTool | null {
  return createLazyMemoryTool({
    options,
    label: "Dream",
    name: "dream",
    description:
      'Run the real multi-phase memory dreaming consolidation engine (light, REM, deep) on demand. `phase` selects light|rem|deep|all (default all). `scope` selects which memory workspaces to consolidate: "fleet" (default) runs every configured agent\'s workspace, or pass an explicit agent id to run just that workspace. Light/REM stage candidate insights; deep promotes recurring short-term recalls into durable MEMORY.md entries and writes Dream Diary narratives. Returns a per-workspace summary.',
    parameters: DreamSchema,
    unavailableError: "memory dreaming unavailable",
    load: async (loadOptions) => {
      const { createDreamTool } = await import("./src/tools.dream.js");
      return createDreamTool({ api, options: loadOptions });
    },
  });
}

function resolveMemoryToolOptions(ctx: OpenClawPluginToolContext): MemoryToolOptions {
  const getConfig = () => ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  return {
    config: getConfig(),
    getConfig,
    agentId: ctx.agentId,
    agentSessionKey: ctx.sessionKey,
    sandboxed: ctx.sandboxed,
    oneShotCliRun: ctx.oneShotCliRun,
  };
}

const memoryRuntime: MemoryPluginRuntime = {
  async getMemorySearchManager(params) {
    const { memoryRuntime: runtime } = await loadRuntimeProviderModule();
    return await runtime.getMemorySearchManager(params);
  },
  resolveMemoryBackendConfig(params) {
    return resolveMemoryBackendConfig(params);
  },
  async closeAllMemorySearchManagers() {
    const { memoryRuntime: runtime } = await loadRuntimeProviderModule();
    await runtime.closeAllMemorySearchManagers?.();
  },
  async closeMemorySearchManager(params) {
    const { memoryRuntime: runtime } = await loadRuntimeProviderModule();
    await runtime.closeMemorySearchManager?.(params);
  },
};
export default definePluginEntry({
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  register(api) {
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
      api.runtime.state.openKeyedStore<T>(options),
    );
    registerBuiltInMemoryEmbeddingProviders(api);
    registerShortTermPromotionDreaming(api);
    api.registerMemoryCapability({
      promptBuilder: buildPromptSection,
      flushPlanResolver: buildMemoryFlushPlan,
      runtime: memoryRuntime,
      publicArtifacts: {
        async listArtifacts(params) {
          const { listMemoryCorePublicArtifacts } = await import("./src/public-artifacts.js");
          return await listMemoryCorePublicArtifacts(params);
        },
      },
    });

    api.registerTool((ctx) => createLazyMemorySearchTool(resolveMemoryToolOptions(ctx)), {
      names: ["memory_search"],
    });

    api.registerTool((ctx) => createLazyMemoryGetTool(resolveMemoryToolOptions(ctx)), {
      names: ["memory_get"],
    });

    api.registerTool((ctx) => createLazyMemoryIngestTool(resolveMemoryToolOptions(ctx)), {
      names: ["memory_ingest"],
    });

    api.registerTool((ctx) => createLazyDreamTool(api, resolveMemoryToolOptions(ctx)), {
      names: ["dream"],
    });

    api.registerCommand({
      name: "dreaming",
      description: "Enable or disable memory dreaming.",
      acceptsArgs: true,
      handler: async (ctx) => {
        const { handleDreamingCommand } = await import("./src/dreaming-command.js");
        return await handleDreamingCommand(api, ctx);
      },
    });

    api.registerCli(
      async ({ program }) => {
        const { registerMemoryCli } = await import("./cli.js");
        registerMemoryCli(program);
      },
      {
        descriptors: [
          {
            name: "memory",
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
