// Memory Core plugin module implements the `dream` agent tool: an HTTP-driven
// entry point into the real multi-phase dreaming consolidation engine.
//
// Phase control note: OpenClaw's dreaming engine has no native phase parameter.
// The real cron entry point (runShortTermDreamingPromotionIfTriggered) is
// tightly coupled: it always runs the light + REM sweep (runDreamingSweepPhases)
// AND the inline deep promotion, and when a `cfg` is supplied it re-derives the
// plugin config from `cfg` (ignoring any per-call override) and fans out across
// ALL configured agent workspaces. To get both per-scope workspace control and
// per-phase control while staying on the REAL engine code paths, this tool:
//   - light / rem (only): calls runDreamingSweepPhases directly with a
//     phase-scoped plugin config (true single-phase, scoped per workspace).
//   - deep / all: calls the real entry fn once per workspace with cfg=undefined
//     so it scopes to exactly that workspace. For `phase=deep` the engine's
//     coupling means the (non-destructive) light/REM staging sweep also runs;
//     only the deep phase writes durable MEMORY.md promotions. This is surfaced
//     in the result via `lightRemSideEffect`.
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import {
  asToolParamsRecord,
  jsonResult,
  readStringParam,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryCorePluginConfig,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import {
  resolveShortTermPromotionDreamingConfig,
  runShortTermDreamingPromotionIfTriggered,
} from "./dreaming.js";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import { createMemoryTool } from "./tools.shared.js";

type DreamPhase = "all" | "light" | "rem" | "deep";

export const DreamSchema = Type.Object({
  phase: Type.Optional(stringEnum(["all", "light", "rem", "deep"])),
  scope: Type.Optional(Type.String()),
});

type DreamToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  oneShotCliRun?: boolean;
};

type DreamLogger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type DreamWorkspaceResult = {
  workspaceDir: string;
  ranLight: boolean;
  ranRem: boolean;
  ranDeep: boolean;
  lightRemSideEffect?: boolean;
  deepReason?: string;
  error?: string;
};

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build a per-call plugin config that enables dreaming and restricts the active
 * light/REM phases to the requested one. Phases are gated by their
 * `phases.<phase>.{enabled,limit}`; `limit: 0` + `enabled:false` disables a
 * phase. The base config is otherwise preserved (engine defaults still apply to
 * any unset field). Used only for the direct light/REM sweep path.
 */
function buildPhaseScopedPluginConfig(params: {
  basePluginConfig: Record<string, unknown> | undefined;
  wantLight: boolean;
  wantRem: boolean;
}): Record<string, unknown> {
  const base = asPlainRecord(params.basePluginConfig);
  const baseDreaming = asPlainRecord(base.dreaming);
  const basePhases = asPlainRecord(baseDreaming.phases);
  const baseLight = asPlainRecord(basePhases.light);
  const baseRem = asPlainRecord(basePhases.rem);

  const scopePhase = (
    basePhase: Record<string, unknown>,
    want: boolean,
  ): Record<string, unknown> =>
    want ? { ...basePhase } : { ...basePhase, enabled: false, limit: 0 };

  return {
    ...base,
    dreaming: {
      ...baseDreaming,
      // Force the engine on for this explicit invocation even if cron dreaming
      // is disabled in the operator's config.
      enabled: true,
      phases: {
        ...basePhases,
        light: scopePhase(baseLight, params.wantLight),
        rem: scopePhase(baseRem, params.wantRem),
      },
    },
  };
}

/**
 * Build the deep-phase config consumed by the real cron entry fn. Forces the
 * deep phase enabled so an explicit `dream` invocation runs even when cron
 * dreaming is disabled in operator config.
 */
function buildDeepConfig(params: {
  basePluginConfig: Record<string, unknown> | undefined;
  cfg: OpenClawConfig;
}): ReturnType<typeof resolveShortTermPromotionDreamingConfig> {
  const base = asPlainRecord(params.basePluginConfig);
  const baseDreaming = asPlainRecord(base.dreaming);
  const basePhases = asPlainRecord(baseDreaming.phases);
  const baseDeep = asPlainRecord(basePhases.deep);
  const pluginConfig: Record<string, unknown> = {
    ...base,
    dreaming: {
      ...baseDreaming,
      enabled: true,
      phases: {
        ...basePhases,
        deep: { ...baseDeep, enabled: true },
      },
    },
  };
  const config = resolveShortTermPromotionDreamingConfig({
    pluginConfig,
    cfg: params.cfg,
  });
  return { ...config, enabled: true };
}

/**
 * Resolve the workspace directories in scope. `scope` of "fleet"/"all" (or
 * empty) resolves every configured agent's workspace; any other value is
 * treated as an explicit agent id and resolves that agent's workspace.
 */
function resolveScopedWorkspaces(params: { cfg: OpenClawConfig; scope: string }): string[] {
  const scope = params.scope.trim().toLowerCase();
  const all = resolveMemoryDreamingWorkspaces(params.cfg);
  if (scope === "" || scope === "fleet" || scope === "all") {
    return all.map((entry) => entry.workspaceDir);
  }
  const matched = all.filter((entry) => entry.agentIds.includes(scope));
  // A specific (non-fleet) scope resolves only that agent's workspace(s). If the
  // requested agent id is unknown, return empty rather than silently fanning out
  // across the whole fleet.
  return matched.map((entry) => entry.workspaceDir);
}

export function createDreamTool(params: { api: OpenClawPluginApi; options: DreamToolOptions }) {
  const { api } = params;
  return createMemoryTool({
    options: params.options,
    label: "Dream",
    name: "dream",
    description:
      'Run the real multi-phase memory dreaming consolidation engine (light, REM, deep) on demand. `phase` selects light|rem|deep|all (default all). `scope` selects which memory workspaces to consolidate: "fleet" (default) runs every configured agent\'s workspace, or pass an explicit agent id to run just that workspace. Light/REM stage candidate insights; deep promotes recurring short-term recalls into durable MEMORY.md entries and writes Dream Diary narratives. Returns a per-workspace summary.',
    parameters: DreamSchema,
    execute:
      ({ cfg }) =>
      async (_toolCallId, toolParams) => {
        const rawParams = asToolParamsRecord(toolParams);
        const phaseRaw = (readStringParam(rawParams, "phase") ?? "all").toLowerCase();
        const phase: DreamPhase =
          phaseRaw === "light" || phaseRaw === "rem" || phaseRaw === "deep"
            ? (phaseRaw as DreamPhase)
            : "all";
        const scope = readStringParam(rawParams, "scope") ?? "fleet";

        const logger: DreamLogger = api.logger;
        const subagent = api.runtime?.subagent;

        const basePluginConfig = resolveMemoryCorePluginConfig(cfg) ?? api.pluginConfig ?? undefined;

        const workspaces = resolveScopedWorkspaces({ cfg, scope });
        if (workspaces.length === 0) {
          return jsonResult({
            phase,
            scope,
            workspaceCount: 0,
            workspaces: [],
            warning: "no memory workspace resolved for the requested scope",
          });
        }

        const wantLight = phase === "all" || phase === "light";
        const wantRem = phase === "all" || phase === "rem";
        const wantDeep = phase === "all" || phase === "deep";

        const results: DreamWorkspaceResult[] = [];

        for (const workspaceDir of workspaces) {
          const entry: DreamWorkspaceResult = {
            workspaceDir,
            ranLight: false,
            ranRem: false,
            ranDeep: false,
          };
          try {
            if (wantDeep) {
              // Real cron entry point, scoped to a single workspace by passing
              // cfg=undefined (so it does not fan out across all workspaces).
              // The engine couples a light+REM staging sweep ahead of deep
              // promotion; that staging is non-destructive. For phase=deep we
              // flag it as a side effect rather than a requested phase.
              const config = buildDeepConfig({ basePluginConfig, cfg });
              const outcome = await runShortTermDreamingPromotionIfTriggered({
                cleanedBody: MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
                trigger: "cron",
                workspaceDir,
                cfg: undefined,
                config,
                logger,
                subagent: config.enabled ? subagent : undefined,
              });
              entry.ranDeep = true;
              entry.deepReason = outcome?.reason;
              if (phase === "all") {
                entry.ranLight = true;
                entry.ranRem = true;
              } else {
                // phase === "deep": light/REM staging ran as an engine side
                // effect (default config), not as a requested phase.
                entry.lightRemSideEffect = true;
              }
            } else {
              // Light/REM-only: call the real sweep engine directly with a
              // phase-scoped plugin config so only the requested phase runs.
              const pluginConfig = buildPhaseScopedPluginConfig({
                basePluginConfig,
                wantLight,
                wantRem,
              });
              await runDreamingSweepPhases({
                workspaceDir,
                pluginConfig,
                cfg,
                logger,
                subagent,
                detachNarratives: false,
              });
              entry.ranLight = wantLight;
              entry.ranRem = wantRem;
            }
          } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
            logger.error(
              `memory-core: dream tool failed for workspace ${workspaceDir}: ${entry.error}`,
            );
          }
          results.push(entry);
        }

        return jsonResult({
          phase,
          scope,
          workspaceCount: results.length,
          workspaces: results,
        });
      },
  });
}
