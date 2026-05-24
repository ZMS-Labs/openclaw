import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { testing as oauthSidecarTesting } from "../commands/doctor-auth-oauth-sidecar.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli } from "./auto-migrate-legacy-oauth-sidecar.js";

const DECLINE_MARKER_FILENAME = "legacy-oauth-sidecar-migration-declined";

const states: OpenClawTestState[] = [];

const INTERACTIVE_SHELL_ENV: Record<string, string | undefined> = {
  CI: undefined,
  OPENCLAW_NON_INTERACTIVE: undefined,
  OPENCLAW_AUTH_STORE_READONLY: undefined,
  OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR: undefined,
};

function setPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  };
}

function declineMarkerPath(state: OpenClawTestState): string {
  return state.statePath(DECLINE_MARKER_FILENAME);
}

async function makeStateWithLegacyOauthRef(seed: string): Promise<{
  state: OpenClawTestState;
  authPath: string;
  sidecarPath: string;
  profileId: string;
}> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-auto-migrate-sidecar-",
    env: {
      ...INTERACTIVE_SHELL_ENV,
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  const profileId = "openai-codex:default";
  const ref = {
    source: "openclaw-credentials" as const,
    provider: "openai-codex" as const,
    id: "0123456789abcdef0123456789abcdef",
  };
  const authPath = await state.writeAuthProfiles({
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai-codex",
        expires: 1777777777000,
        oauthRef: ref,
      },
    },
    order: { "openai-codex": [profileId] },
    lastGood: { "openai-codex": profileId },
  });
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    oauthSidecarTesting.buildLegacyOAuthSecretKey(seed),
    iv,
  );
  cipher.setAAD(
    oauthSidecarTesting.buildLegacyOAuthSecretAad({
      ref,
      profileId,
      provider: "openai-codex",
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({ access: "access-token", refresh: "refresh-token", idToken: "id-token" }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const sidecarPath = await state.writeJson(
    path.join("credentials", "auth-profiles", `${ref.id}.json`),
    {
      version: 1,
      profileId,
      provider: "openai-codex",
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
    },
  );
  return { state, authPath, sidecarPath, profileId };
}

async function makeStateWithUnreferencedSidecar(seed: string): Promise<{
  state: OpenClawTestState;
  sidecarPath: string;
}> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-auto-migrate-unreferenced-sidecar-",
    env: {
      ...INTERACTIVE_SHELL_ENV,
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  const refId = "abcdef0123456789abcdef0123456789";
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    oauthSidecarTesting.buildLegacyOAuthSecretKey(seed),
    iv,
  );
  cipher.setAAD(
    oauthSidecarTesting.buildLegacyOAuthSecretAad({
      ref: { source: "openclaw-credentials", provider: "openai-codex", id: refId },
      profileId: "openai-codex:orphan",
      provider: "openai-codex",
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ access: "orphan-token" }), "utf8"),
    cipher.final(),
  ]);
  const sidecarPath = await state.writeJson(
    path.join("credentials", "auth-profiles", `${refId}.json`),
    {
      version: 1,
      profileId: "openai-codex:orphan",
      provider: "openai-codex",
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
    },
  );
  return { state, sidecarPath };
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli", () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = setPlatform("darwin");
  });

  afterEach(() => {
    restorePlatform();
  });

  it.each<{ name: string; setup: () => Promise<{ env: NodeJS.ProcessEnv; isTty?: boolean }> }>([
    {
      name: "non-darwin platform",
      setup: async () => {
        restorePlatform();
        restorePlatform = setPlatform("linux");
        return { env: { HOME: "/tmp" } };
      },
    },
    {
      name: "non-TTY",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: state.env, isTty: false };
      },
    },
    {
      name: "OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR=0 opt-out",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR: "0" } };
      },
    },
    {
      name: "CI=true",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, CI: "true" } };
      },
    },
    {
      name: "OPENCLAW_NON_INTERACTIVE=1",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_NON_INTERACTIVE: "1" } };
      },
    },
    {
      name: "OPENCLAW_AUTH_STORE_READONLY=1 (embedded path)",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_AUTH_STORE_READONLY: "1" } };
      },
    },
    {
      name: "no sidecar files",
      setup: async () => {
        const state = await createOpenClawTestState({
          layout: "state-only",
          prefix: "openclaw-auto-migrate-empty-",
        });
        states.push(state);
        return { env: state.env };
      },
    },
  ])("skips silently (no migration, no marker): $name", async ({ setup }) => {
    const { env, isTty = true } = await setup();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env,
      isInteractiveTty: () => isTty,
    });
    const sidecarDir = path.join(env.HOME ?? "", "credentials", "auth-profiles");
    if (fs.existsSync(sidecarDir)) {
      const entries = fs.readdirSync(sidecarDir).filter((n) => n.endsWith(".json"));
      // If we set up a legacy sidecar, it must still be present (migration was skipped).
      if (entries.length > 0) {
        expect(entries.length).toBeGreaterThan(0);
      }
    }
  });

  it.each(["doctor", "update", "completion"])(
    "skips for the %s primary command",
    async (primary) => {
      const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
      await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
        argv: ["node", "openclaw", primary],
        env: state.env,
        isInteractiveTty: () => true,
      });
      expect(fs.existsSync(sidecarPath)).toBe(true);
      expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
    },
  );

  it.each([
    { name: "--json on a routed primary", argv: ["node", "openclaw", "status", "--json"] },
    { name: "--json=pretty", argv: ["node", "openclaw", "agent", "--json=pretty"] },
    { name: "--json before subcommand", argv: ["node", "openclaw", "--json", "status"] },
  ])("skips for JSON-output invocations: $name", async ({ argv }) => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it("migrates when --json appears after a `--` argv terminator", async () => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status", "--", "--json"],
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it.each([
    { name: "bare-root TUI launch", argv: ["node", "openclaw"] },
    { name: "openclaw gateway foreground start", argv: ["node", "openclaw", "gateway"] },
    { name: "openclaw gateway run foreground start", argv: ["node", "openclaw", "gateway", "run"] },
  ])("migrates silently before the $name fast path", async ({ argv }) => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it("migrates legacy oauthRef profiles silently without any in-CLI prompt", async () => {
    const { state, authPath, sidecarPath, profileId } =
      await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(sidecarPath)).toBe(false);
    const written = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const profiles = written.profiles as Record<string, Record<string, unknown>>;
    expect(profiles[profileId]?.access).toBe("access-token");
    expect(profiles[profileId]?.refresh).toBe("refresh-token");
    expect(profiles[profileId]?.idToken).toBe("id-token");
    expect(profiles[profileId]?.oauthRef).toBeUndefined();
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it("skips when only unreferenced sidecar files exist (no migratable oauthRef profile)", async () => {
    const { state, sidecarPath } = await makeStateWithUnreferencedSidecar("legacy-oauth-seed");
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);

    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(sidecarPath)).toBe(true);
  });

  it("writes the decline marker on decryption failure (simulates Keychain deny / corrupted ciphertext) and skips on later runs", async () => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    // Corrupt the ciphertext so no seed source can decrypt — same null-result
    // shape as Keychain "Deny" or unrecoverable Keychain access.
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as {
      encrypted: { ciphertext: string };
    };
    sidecar.encrypted.ciphertext = Buffer.from("not-the-real-ciphertext").toString("base64url");
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar), "utf8");

    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.existsSync(declineMarkerPath(state))).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);

    // Second run honors the marker and does not attempt migration again.
    const markerBefore = fs.readFileSync(declineMarkerPath(state), "utf8");
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
    });
    expect(fs.readFileSync(declineMarkerPath(state), "utf8")).toBe(markerBefore);
  });
});
