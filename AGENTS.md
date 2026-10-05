# AGENTS.md

Instructions for AI coding agents and humans working on hashspan-lab.

## Project
hashspan-lab runs scenarios with the published hashspan packages (`@hashspan/core`, `@hashspan/viem`,
`@hashspan/cdp`, `@hashspan/x402` from npm) against a local chain, sends their traces and metrics to a local stack and
shows them in dashboards. The lab is a user of hashspan, not part of it: it installs the packages from npm like anyone
else. Changes to hashspan itself go to its own repository.

## Setup and commands
- Node from `.nvmrc` (`nvm use`); pnpm via corepack (`corepack enable pnpm`)
- `make install`, `make check` (lint, typecheck, unit tests), `make test-integration` (needs Anvil, installed by
  `make tools`)
- `make lab-up`, `make scenario-local NAME=<scenario>`, `make lab-check`, `make lab-nuke`
- Run lint, typecheck and tests before proposing a change.

## Layout
- `packages/common`: the toolkit, TypeScript, every helper unit-tested
- `scenarios/<name>/`: one small package per scenario, using `common`; a new scenario is a new folder
- `stack/`: `compose.yaml` and the collector, Prometheus and Tempo configuration
- `dashboards/`: Grafana dashboard JSON, provisioned by the stack

## Conventions
- English for code, comments, docs, commits and PRs. Conventional Commits, subject at most 72 characters.
- Tests first; every helper in `common` has a unit test; anything touching RPC is tested against Anvil. Tests never use
  a public network.
- Exact dependency versions, lockfile committed; container images pinned by digest. New dependencies need a reason in
  the pull request; prefer OSI-licensed ones.
- Never commit keys or `.env` files; gitleaks runs in CI.
- Small, focused pull requests. No force push.
