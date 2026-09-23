# About this fork of OpenClaw

This repository is my fork of [openclaw/openclaw](https://github.com/openclaw/openclaw). OpenClaw's authors wrote the product and own it. On its `main` branch the fork adds a few notes and files of mine, including one automated check that is switched off, and an open pull request adds memory tools.

## Start here

| Reader task                                                                       | Guide                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand or install OpenClaw                                                    | [Upstream getting started](https://docs.openclaw.ai/start/getting-started) and the [README](README.md)                                                                                                                                                         |
| Understand this fork                                                              | [Where the fork sits against upstream](#where-the-fork-sits-against-upstream), [What my fork adds](#what-my-fork-adds), [Memory tools in progress](#memory-tools-in-progress-pull-request-1) and [How upstream changes come in](#how-upstream-changes-come-in) |
| Develop or propose a product change                                               | [CONTRIBUTING.md](CONTRIBUTING.md) and the [upstream repository](https://github.com/openclaw/openclaw)                                                                                                                                                         |
| Choose checks for a change                                                        | [Testing guide](https://docs.openclaw.ai/reference/test) and the scripts in [package.json](package.json)                                                                                                                                                       |
| Report a security issue in OpenClaw                                               | OpenClaw's [security policy](SECURITY.md)                                                                                                                                                                                                                      |
| Report a security issue in my changes (the files listed below or pull request #1) | This fork's [private vulnerability reporting](https://github.com/ZMS-Labs/openclaw/security/advisories/new)                                                                                                                                                    |
| Check licensing                                                                   | [License](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md)                                                                                                                                                                                           |
| Ask about this fork                                                               | Issues are turned off here. Questions about OpenClaw itself belong in the [upstream repository](https://github.com/openclaw/openclaw). Questions and conversations are welcome through [my GitHub profile](https://github.com/SternOne).                       |

Upstream badges and release links describe upstream OpenClaw. They say nothing about this fork's state or my changes.

## Where the fork sits against upstream

The fork's `main` is built on upstream OpenClaw as of 2026-06-13, commit `dbf24fe35af52e283c5515824f6db237a050faac`, plus the fork's own commits. It has not taken an upstream update since. On 2026-07-23, upstream `main` was at `2b7622d9a3a7c92efe7ec65e098fe8698570f4dd` and had 12,897 commits this fork did not have. This fork's `main` was at `fbc8d48a12191319a31d8349c81c8cc0844892cd`, with three commits of its own that added the rules for AI agents and their check.

## What my fork adds

Compared with that upstream commit, the fork's `main` changes four files and nothing else:

- `AGENTS.md`: a block of rules for the AI agents that work in this repository, added above upstream's own text;
- `.github/workflows/posture.yml`: one automated check that the block is up to date, which does not run because GitHub Actions is turned off on this fork;
- `README.md`: the status line and the note at the top of the page;
- `ZMS_UPSTREAM.md`: this page.

This list matches GitHub's [comparison with that commit](https://github.com/ZMS-Labs/openclaw/compare/dbf24fe35af52e283c5515824f6db237a050faac...main) as of 2026-09-22. The status line at the top of the README comes from a private list I keep of my projects, so it can't be checked from here.

## Memory tools in progress (pull request #1)

Open pull request [#1](https://github.com/ZMS-Labs/openclaw/pull/1) adds three tools to OpenClaw's memory-core plugin: `memory_ingest`, `memory_remove` and `dream`. AI tools write the code. I decide what each project is for and check what comes back. The aim is to let another program, my [Fleet Orchestrator](https://zms-labs.github.io/showcase/case-studies/fleet-orchestrator/) project, use HTTP to add to, remove from and consolidate what OpenClaw remembers. `dream` has an off switch that stops new runs without a code change, and there are tests for `memory_ingest` and `dream`. When the pull request was opened, its description said `memory_ingest` hung once the memory store already held documents, and asked that it not be merged until that was fixed. A later comment on the pull request reports the hang fixed in a test with made-up documents. I'm keeping it out of `main` until the fix is shown outside a test, on a memory store that already holds documents.

## How upstream changes come in

I don't take upstream changes automatically. Before the fork moves to a newer upstream version, the update is compared against the upstream commit the fork is built on, checked for conflicts with OpenClaw's code and with the files listed above, and run through the checks upstream asks for. The status line at the top of the README is regenerated at the same time, and OpenClaw's credits and license stay exactly as upstream has them. If an update can't pass all of that, the fork stays on the last version that did, and OpenClaw's own code is not edited here to make it fit.
