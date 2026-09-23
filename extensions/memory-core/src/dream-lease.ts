// Memory Core plugin module implements the dream lease: per-workspace mutual
// exclusion for dreaming consolidation so two dream invocations can never run
// competing deep promotions on the same corpus.
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Lease file lives inside the workspace memory dir, next to the corpus. */
export function dreamLeasePath(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", ".dream-lease.json");
}

export type DreamLease = {
  holder: string;
  acquired_at: string;
  expires_at: string;
};

export type AcquireResult =
  | { acquired: true; holder: string }
  | { acquired: false; reason: "held"; lease: DreamLease };

function nowMs(): number {
  return Date.now();
}

function isExpired(lease: DreamLease): boolean {
  return Date.parse(lease.expires_at) <= nowMs();
}

/**
 * Acquire the workspace dream lease. A live lease blocks; a stale (expired)
 * lease is recoverable and gets stolen — the previous holder either crashed or
 * lost its clock, and the lease must not park dreaming forever.
 */
export async function acquireDreamLease(params: {
  workspaceDir: string;
  ttlMs: number;
}): Promise<AcquireResult> {
  const leasePath = dreamLeasePath(params.workspaceDir);
  const holder = randomBytes(12).toString("hex");
  const now = new Date();
  const lease: DreamLease = {
    holder,
    acquired_at: now.toISOString(),
    expires_at: new Date(now.getTime() + params.ttlMs).toISOString(),
  };
  await fs.mkdir(path.dirname(leasePath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const existing = JSON.parse(await fs.readFile(leasePath, "utf8")) as DreamLease;
      if (!isExpired(existing)) {
        return { acquired: false, reason: "held", lease: existing };
      }
    } catch {
      // No lease file (or unreadable): treat as absent.
    }
    // Steal-or-create is a single atomic rename of a uniquely-named temp file;
    // a race between two stealers resolves when one rename wins per attempt.
    const tmp = `${leasePath}.tmp-${holder}`;
    await fs.writeFile(tmp, JSON.stringify(lease) + "\n", "utf8");
    try {
      await fs.rename(tmp, leasePath);
      return { acquired: true, holder };
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
  // Could not win the window after retries: report the current lease honestly.
  try {
    const existing = JSON.parse(await fs.readFile(leasePath, "utf8")) as DreamLease;
    return { acquired: false, reason: "held", lease: existing };
  } catch {
    return {
      acquired: false,
      reason: "held",
      lease: {
        holder: "unknown",
        acquired_at: "",
        expires_at: new Date(nowMs() + 60_000).toISOString(),
      },
    };
  }
}

/**
 * Release the lease when this holder still owns it. Idempotent: releasing an
 * absent, expired, or stolen lease is a no-op, so cancellation paths and stale
 * recoveries cannot delete a successor's lease.
 */
export async function releaseDreamLease(params: {
  workspaceDir: string;
  holder: string;
}): Promise<void> {
  const leasePath = dreamLeasePath(params.workspaceDir);
  try {
    const existing = JSON.parse(await fs.readFile(leasePath, "utf8")) as DreamLease;
    if (existing.holder === params.holder) {
      await fs.rm(leasePath, { force: true });
    }
  } catch {
    // Already gone.
  }
}
