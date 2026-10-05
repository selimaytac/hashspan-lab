# hashspan-lab

Scenarios that run AI agents with the published [hashspan](https://github.com/selimaytac/hashspan) packages, a local
telemetry stack (collector, Tempo, Prometheus, Grafana) with dashboards, and a tested toolkit (`packages/common`)
the scenarios share.

Status: work in progress.

## Run it locally

You need Docker, Node from `.nvmrc` (`nvm use`) and pnpm via corepack (`corepack enable pnpm`). No key and no account.

```sh
make demo        # pnpm install --frozen-lockfile, then pnpm lab up
```

With the dependencies installed, `pnpm lab up` is the same.

`pnpm lab up` checks your machine (each failure says what to do), starts the stack (collector, Tempo, Prometheus,
Grafana), runs every scenario on a local chain, checks that the dashboards show data and prints their links, with an example trace.

```sh
pnpm lab status           # containers, readiness, links
pnpm lab run <scenario>   # one scenario; the names are the folders of scenarios/
pnpm lab down             # stop, keep the data
pnpm lab nuke             # remove containers, volumes, images and .tools
```

Grafana is on `http://127.0.0.1:13000` (no login), the collector takes OTLP on `127.0.0.1:14317` (gRPC) and
`http://127.0.0.1:14318` (HTTP). The ports differ from the OTLP defaults so the stack runs beside another local backend.
`make help` lists the other targets. Tests never touch a public network: `make check` runs lint, typecheck and unit
tests, `make test-integration` runs the chain tests against a local Anvil.

## Testnet mode

```sh
pnpm lab testnet [--chain base-sepolia|sepolia|arbitrum-sepolia|op-sepolia] [--scenario treasury,paths|all] [--rpc <url>] [--save] [--yes]
```

Runs scenarios on a real testnet with your own account, and sends the telemetry to the same local stack (`pnpm lab up`
first). You give the key by hidden input, or in `LAB_PRIVATE_KEY`; `--save` keeps it in `.lab/testnet.env` (mode 600,
not tracked by git), otherwise it is never written down. Before anything is sent the command checks that the RPC's
`eth_chainId` is one of the four testnets and the one you chose (mainnets and unknown chains are refused, also with your own
`--rpc` or `LAB_RPC_URL`), shows the derived address, the balance and about what the run costs, refuses a balance below it
and asks to confirm (`--yes` skips the question). The key and the RPC URL are removed from every line the scenarios print.

Which scenarios can run depends on the chain and on what you give: `treasury`, `eip7702` and `soak` run on all four chains;
`paths`, `call-batches`, `user-operations`, `user-operations-v07`, `x402` (needs test USDC on the account) and `sealed-fees`
(read-only, needs no key) on Base Sepolia only; `cdp` also needs `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` and
`CDP_WALLET_SECRET`. The others are listed as skipped, with the reason. The default is `treasury`. Costs are measured
for three chains and an estimate for Base Sepolia (`packages/common/src/testnets.ts`).

## First run of a release

`pnpm lab first-run [--version rc|latest|<version>]` does what a new user does with the published packages: it takes the
quick start of [hashspan's README](https://github.com/selimaytac/hashspan#quick-start) at the release's own git tag,
installs `@hashspan/viem` (pinned to that release) and the other packages from the npm registry into an empty
project outside this workspace, saves the example as `agent.ts`, runs it against a local Anvil with the lab collector as
its OTLP endpoint, and checks in Tempo that `pay_vendor` has a `send` and a `confirm` span under it. The stack must be
up (`pnpm lab up`). A command in the README that the lab does not know fails the run before anything is executed, so a
change of the quick start is noticed; the example's code runs with an environment that holds no key and no token.
`.github/workflows/first-run.yml` runs it weekly for `rc` and `latest`.

## Use the lab with your own agent

`pnpm lab connect` prints the three environment variables (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:14318`,
`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_SERVICE_NAME`) that send an agent's telemetry to the lab's collector.
Any service name works: the dashboards show every service. Instrumenting the agent, and flushing before a short-lived
process exits, are described in hashspan's [README](https://github.com/selimaytac/hashspan#readme) and its
[example agent](https://github.com/selimaytac/hashspan/tree/main/examples/ai-sdk-agent).

## Layout

| Path | What |
|---|---|
| `scenarios/<name>/` | one small package per scenario, with its own checks of the spans it expects |
| `packages/common/` | the shared toolkit: env and RPC validation, chain refusal, telemetry setup, span checks |
| `stack/` | the Docker Compose stack and its configuration, images pinned by digest |
| `dashboards/` | Grafana dashboards, provisioned by the stack |
| `docs/upstream/` | write-ups of problems found in other projects |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Apache-2.0, see [LICENSE](LICENSE).
