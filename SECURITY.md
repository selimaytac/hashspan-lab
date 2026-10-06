# Security

## Reporting a vulnerability

Please report a vulnerability privately: on the repository's **Security** tab, choose **Report a vulnerability**
(GitHub private vulnerability reporting). Do not open a public issue for it. Include what you found, how to reproduce
it, and what it lets someone do. You will get a first answer from a maintainer; this is a small project without a
fixed response time.

A vulnerability in hashspan itself belongs to [its own policy](https://github.com/selimaytac/hashspan/security/policy).

## What is in scope

Only the `main` branch is supported. The lab runs on your machine: it is not a hosted service.

- The local stack binds every port to `127.0.0.1` only, and Grafana lets anonymous visitors view dashboards. Do not
  expose these ports to a network you do not trust.
- Testnet mode (`pnpm lab testnet`) uses your own key, which it keeps in memory, or in `.lab/testnet.env` (mode 600)
  only with `--save`. It refuses a chain id that is not one of four testnets and removes the key and the RPC URL from
  the output of the scenarios. Use a key that holds testnet funds only, never one that holds real value.
- Reports about a way to make the lab leak a key, send on a mainnet, run code from outside the repository, or weaken
  the pinned dependencies and images are in scope.
