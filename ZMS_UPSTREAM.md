# ZMS upstream provenance

This repository is a fork of [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Upstream OpenClaw is the primary author and product authority; the ZMS fork is a maintenance surface for a bounded governance overlay and is not a ZMS promotable-product lane.

## Observed revision boundary

- Pinned upstream base: `dbf24fe35af52e283c5515824f6db237a050faac`
- Upstream `main` observed on 2026-07-23: `2b7622d9a3a7c92efe7ec65e098fe8698570f4dd`
- ZMS `main` observed on 2026-07-23: `fbc8d48a12191319a31d8349c81c8cc0844892cd`
- Observed divergence: upstream had 12,897 commits not in ZMS; ZMS had three governance commits not in upstream.

The authoritative estate record is `ZMS-Labs/zms-homelab/governance/estate.yaml`.

## ZMS-authored overlay

The default-branch overlay is limited to:

- `AGENTS.md` governance content;
- `.github/workflows/posture.yml`;
- the generated ZMS lifecycle block in `README.md` once its draft PR lands;
- this `ZMS_UPSTREAM.md` provenance record.

Everything else remains upstream-owned unless a later reviewed record explicitly changes this boundary.

## Update and divergence policy

Upstream updates are manual-review events. Compare from the pinned base, inspect product and overlay conflicts, preserve attribution and licensing, regenerate the lifecycle projection, and run upstream-required verification before advancing the pin. If provenance, governance, or verification cannot be preserved, keep the ZMS fork parked at the last reviewed revision; do not resolve the conflict by silently editing upstream-owned product code.
