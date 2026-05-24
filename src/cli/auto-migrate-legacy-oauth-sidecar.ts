import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasJsonOutputFlag } from "./json-output-mode.js";

const DECLINE_MARKER_FILENAME = "legacy-oauth-sidecar-migration-declined";

const SKIPPED_PRIMARIES = new Set(["doctor", "update", "help", "completion", "version"]);

function hasSidecarFiles(env: NodeJS.ProcessEnv): boolean {
  const sidecarDir = path.join(resolveOAuthDir(env), "auth-profiles");
  try {
    return fs
      .readdirSync(sidecarDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    return false;
  }
}

function resolveDeclineMarkerPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), DECLINE_MARKER_FILENAME);
}

function shouldSkip(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isInteractiveTty: () => boolean;
}): boolean {
  if (process.platform !== "darwin") {
    return true;
  }
  // TTY check keeps the macOS Keychain dialog from appearing on cron/launchd
  // runs where there's no human seated to consent.
  if (!params.isInteractiveTty()) {
    return true;
  }
  const env = params.env;
  if (
    env.OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR === "0" ||
    env.OPENCLAW_NON_INTERACTIVE === "1" ||
    env.CI === "true" ||
    env.CI === "1" ||
    env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return true;
  }
  const invocation = resolveCliArgvInvocation(params.argv);
  if (invocation.hasHelpOrVersion) {
    return true;
  }
  if (invocation.primary && SKIPPED_PRIMARIES.has(invocation.primary)) {
    return true;
  }
  // Don't pop a Keychain dialog mid-`--json` pipeline; consumers want clean
  // output, and `openclaw doctor --fix` is the documented retry path.
  if (hasJsonOutputFlag(params.argv)) {
    return true;
  }
  if (!hasSidecarFiles(env)) {
    return true;
  }
  if (fs.existsSync(resolveDeclineMarkerPath(env))) {
    return true;
  }
  return false;
}

export async function maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  isInteractiveTty?: () => boolean;
}): Promise<void> {
  const env = params.env ?? process.env;
  const isInteractiveTty = params.isInteractiveTty ?? defaultIsInteractiveTty;

  if (shouldSkip({ argv: params.argv, env, isInteractiveTty })) {
    return;
  }

  const [
    { readBestEffortConfig },
    { hasMigratableLegacyOAuthSidecarStores, maybeRepairLegacyOAuthSidecarProfiles },
  ] = await Promise.all([
    import("../config/io.js"),
    import("../commands/doctor-auth-oauth-sidecar.js"),
  ]);

  try {
    const cfg = await readBestEffortConfig();
    if (!hasMigratableLegacyOAuthSidecarStores({ cfg, env })) {
      return;
    }
    // Silent runtime heal: no in-CLI confirm. The macOS Keychain dialog is
    // the only consent surface — on Allow we migrate inline; on Deny or any
    // decryption failure the result is zero changes and we write a permanent
    // marker so the next CLI run does not re-trigger the OS dialog.
    // `openclaw doctor --fix` remains the explicit retry path.
    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg,
      env,
      emitNotes: false,
      prompter: { confirmAutoFix: async () => true },
    });

    if (result.changes.length === 0) {
      const markerPath = resolveDeclineMarkerPath(env);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
    }
  } catch {}
}

function defaultIsInteractiveTty(): boolean {
  const stdinTty = process.stdin.isTTY ?? false;
  const stdoutTty = process.stdout.isTTY ?? false;
  return stdinTty && stdoutTty;
}
