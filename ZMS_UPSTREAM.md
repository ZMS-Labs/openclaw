# ZMS upstream provenance

This repository is a fork of [`openclaw/openclaw`](https://github.com/openclaw/openclaw). Upstream OpenClaw is the primary author and product authority; the ZMS fork is a maintenance surface for a bounded governance overlay and is not a ZMS promotable-product lane.

## Start here

| Reader task                                  | Guide                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Understand or install OpenClaw               | [Upstream getting started](https://docs.openclaw.ai/start/getting-started) and the [README](README.md)   |
| Understand this fork                         | The provenance and update policy below                                                                   |
| Develop or propose a product change          | [CONTRIBUTING.md](CONTRIBUTING.md) and [upstream repository](https://github.com/openclaw/openclaw)       |
| Choose checks for a change                   | [Testing guide](https://docs.openclaw.ai/reference/test) and the scripts in [package.json](package.json) |
| Report a security issue or inspect licensing | [Security policy](SECURITY.md), [license](LICENSE), and [third-party notices](THIRD_PARTY_NOTICES.md)    |

Upstream badges and release links describe upstream OpenClaw. They do not establish this fork's deployment state or verify a local overlay. A feature branch or open pull request is not part of the default branch until it is merged.

## Recorded revision boundary (2026-07-23)

- Pinned upstream base: `dbf24fe35af52e283c5515824f6db237a050faac`
- Upstream `main` observed on 2026-07-23: `2b7622d9a3a7c92efe7ec65e098fe8698570f4dd`
- ZMS `main` observed on 2026-07-23: `fbc8d48a12191319a31d8349c81c8cc0844892cd`
- Observed divergence: upstream had 12,897 commits not in ZMS; ZMS had three governance commits not in upstream.

The authoritative estate record is `ZMS-Labs/zms-homelab/governance/estate.yaml`.

## ZMS-authored overlay

At the recorded revision above, the default-branch overlay was limited to:

- `AGENTS.md` governance content;
- `.github/workflows/posture.yml`;
- the generated ZMS lifecycle block in `README.md` once its draft PR lands;
- this `ZMS_UPSTREAM.md` provenance record.

This is a historical provenance boundary, not a fresh inventory of the current tree. Review subsequent commits against the recorded base before claiming that a newer default branch has the same scope. Preserve upstream authorship and licensing in any comparison.

## Update and divergence policy

Upstream updates are manual-review events. Compare from the pinned base, inspect product and overlay conflicts, preserve attribution and licensing, regenerate the lifecycle projection, and run upstream-required verification before advancing the pin. If provenance, governance, or verification cannot be preserved, keep the ZMS fork parked at the last reviewed revision; do not resolve the conflict by silently editing upstream-owned product code.

## Visual documentation quality

Apply the [shared visual documentation standard](https://github.com/ZMS-Labs/.github/blob/main/docs/documentation-standard.md#use-visuals-to-explain)
to all new or changed visual headings, Mermaid diagrams, flowcharts, sequences,
screenshots, and charts. Verify labels, arrows, grouping, order, and status
against authoritative source; distinguish conceptual, planned, implemented, and
observed evidence. Preserve authentic product screenshots and product-local
design identity. Use generated images only for illustrative explanation, and
keep exact diagrams editable.

Inspect the rendered destination at desktop and narrow widths, with readable
labels, a text equivalent, and light/dark presentation where supported. Record
the source scope, actual semantic and render checks, and remaining limits in the
change description. Use one bounded review and recheck affected content; this
standard adds no mandatory independent-model gate. Adoption does not certify
that historical visuals have been reviewed.
