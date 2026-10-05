# Contributing to hashspan-lab

Thanks for looking. The lab is small on purpose: scenarios that exercise the published
[hashspan](https://github.com/selimaytac/hashspan) packages, a local telemetry stack with dashboards, and the toolkit
(`packages/common`) they share.

## Where a change belongs

- A problem in hashspan itself (a wrong span, a missing attribute, a crash): open an issue in
  [hashspan](https://github.com/selimaytac/hashspan/issues) with a repro that does not need this lab. The lab installs
  the published packages and never patches them.
- A new scenario, a fix to a scenario, the stack, the dashboards or the CLI: here.

## Setup

Node from `.nvmrc` (`nvm use`), pnpm via corepack (`corepack enable pnpm`), Docker for the stack.

```sh
make install           # pnpm install --frozen-lockfile
make check             # lint, typecheck, unit tests
make test-integration  # installs a pinned Anvil into .tools/ and runs the tests that need a chain
make demo              # the whole lab: stack, every scenario on a local chain, dashboards
```

## A pull request

- One concern per pull request. Conventional Commits (`feat(lab): ...`, `fix(scenarios): ...`), subject at most 72
  characters, English everywhere.
- Tests first: every helper in `packages/common` has a unit test, and anything that touches an RPC is tested against a
  local Anvil. Tests never use a public network and never need a key.
- A new scenario is a new folder in `scenarios/` that uses `packages/common`, with a `start:local` script, so that
  `pnpm lab up` runs it on a local chain. It fails its run when an expected span or attribute is missing.
- Dependencies are pinned to exact versions and container images to digests. A new dependency needs a reason in the
  pull request; prefer OSI-licensed ones.
- Never commit a key, a token or an `.env` file. Use Anvil's well-known test accounts, or generate a key at run time.
- The CI checks run without secrets and must pass. A maintainer reviews and merges; `.github/`, `scripts/` and `stack/`
  have a code owner.

By contributing you agree that your contribution is licensed under the Apache License 2.0 of this repository.
