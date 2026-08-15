// Memory Core plugin module covers dream tool operational boundaries: kill
// switch, per-workspace lease mutual exclusion, stale-lease recovery, and
// bounded execution. These run against the REAL tool factory with a stub plugin
// api; the engine paths are exercised elsewhere (dreaming*.test.ts).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./memory/test-runtime-mocks.js";
import { acquireDreamLease, dreamLeasePath, releaseDreamLease } from "./dream-lease.js";

type DreamToolModule = typeof import("./tools.dream.js");

function stubApi(): Parameters<DreamToolModule["createDreamTool"]>[0]["api"] {
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Parameters<DreamToolModule["createDreamTool"]>[0]["api"]["logger"];
  return {
    logger,
    runtime: { subagent: undefined },
    pluginConfig: {},
  } as unknown as Parameters<DreamToolModule["createDreamTool"]>[0]["api"];
}

function unwrapToolJson(raw: unknown): Record<string, unknown> {
  const envelope = raw as { content?: Array<{ type?: string; text?: string }> };
  const text = envelope?.content?.find((part) => part.type === "text")?.text;
  if (typeof text === "string") {
    return JSON.parse(text) as Record<string, unknown>;
  }
  return (raw as Record<string, unknown>) ?? {};
}

describe("dream lease primitives", () => {
  let fixtureRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dream-lease-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("acquires, blocks a second holder, and releases", async () => {
    const first = await acquireDreamLease({ workspaceDir, ttlMs: 60_000 });
    expect(first.acquired).toBe(true);
    const second = await acquireDreamLease({ workspaceDir, ttlMs: 60_000 });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.lease.holder).toBe((first as { holder: string }).holder);
    }
    await releaseDreamLease({ workspaceDir, holder: (first as { holder: string }).holder });
    const third = await acquireDreamLease({ workspaceDir, ttlMs: 60_000 });
    expect(third.acquired).toBe(true);
  });

  it("release by a non-holder cannot delete a successor lease", async () => {
    const first = await acquireDreamLease({ workspaceDir, ttlMs: 60_000 });
    const holderA = (first as { holder: string }).holder;
    // A stale release from a previous (already-expired) holder must be a no-op.
    await releaseDreamLease({ workspaceDir, holder: "not-the-holder" });
    expect(fs.readFile(dreamLeasePath(workspaceDir), "utf8")).resolves.toContain(holderA);
  });

  it("a stale (expired) lease is stealable", async () => {
    const first = await acquireDreamLease({ workspaceDir, ttlMs: -1 });
    expect(first.acquired).toBe(true);
    const stolen = await acquireDreamLease({ workspaceDir, ttlMs: 60_000 });
    expect(stolen.acquired).toBe(true);
  });
});

describe("dream tool operational boundaries", () => {
  let fixtureRoot: string;
  let workspaceDir: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dream-tool-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  });

  function dreamCfg(params: { pluginConfig?: Record<string, unknown> } = {}) {
    return {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
      ...(params.pluginConfig
        ? { plugins: { entries: { "memory-core": { config: params.pluginConfig } } } }
        : {}),
    } as never;
  }

  async function callDream(params: Record<string, unknown>, cfg?: unknown) {
    const { createDreamTool } = await import("./tools.dream.js");
    const tool = createDreamTool({
      api: stubApi(),
      options: { config: (cfg ?? dreamCfg()) as never },
    });
    if (!tool) {
      throw new Error("dream tool unavailable");
    }
    return unwrapToolJson(await (tool.execute("dream-boundary", params) as Promise<unknown>));
  }

  it("kill switch refuses new dream execution", { timeout: 30_000 }, async () => {
    const res = await callDream(
      { phase: "light", scope: "main" },
      dreamCfg({ pluginConfig: { dreaming: { toolKillSwitch: true } } }),
    );
    expect(res.disabled).toBe(true);
    expect(String(res.reason)).toContain("kill switch");
    expect(res.workspaceCount).toBe(0);
    // No lease file is left behind by a refused call.
    await expect(fs.readFile(dreamLeasePath(workspaceDir), "utf8")).rejects.toThrow();
  });

  it(
    "a live lease blocks the workspace and is reported honestly",
    { timeout: 30_000 },
    async () => {
      const held = await acquireDreamLease({ workspaceDir, ttlMs: 10 * 60_000 });
      expect(held.acquired).toBe(true);
      const res = await callDream({ phase: "light", scope: "main" });
      expect(res.workspaceCount).toBe(1);
      const workspaces = res.workspaces as Array<Record<string, unknown>>;
      expect(workspaces[0].lease).toBe("held");
      expect(workspaces[0].ranLight).toBe(false);
      await releaseDreamLease({ workspaceDir, holder: (held as { holder: string }).holder });
    },
  );
});
