COMPOSE := docker compose -f stack/compose.yaml
COMPOSE_ALL := $(COMPOSE)
COMPOSE_UP := $(COMPOSE)
# The stack's collector, on its own ports so that other local OTLP backends keep theirs.
LAB_OTLP := http://127.0.0.1:14318

.PHONY: demo node-check help install tools check test-integration lab-up lab-down lab-status lab-logs lab-check lab-nuke scenario scenario-local clean

help: ## Show available targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-18s %s\n", $$1, $$2}'

node-check: ## Check that the Node.js of this shell is the one of .nvmrc
	@expected=$$(tr -d 'v\n' < .nvmrc | cut -d. -f1); actual=$$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null); \
	if [ "$$expected" != "$$actual" ]; then \
	  echo "Node.js $$expected is needed, this shell has $$(node -v 2>/dev/null || echo none): run 'nvm use' in this directory (nvm: https://github.com/nvm-sh/nvm), then try again"; exit 1; \
	fi

demo: install ## One command: check the machine, start the stack, run every local scenario, show the dashboards
	pnpm lab up

install: node-check ## Install dependencies from the lockfile
	pnpm install --frozen-lockfile

tools: ## Install pinned Anvil into ./.tools/bin (project-local)
	./scripts/install-anvil.sh

check: ## Lint, typecheck and unit tests
	pnpm lint
	pnpm typecheck
	pnpm test

test-integration: tools ## Integration tests against a local Anvil
	pnpm test:integration

lab-up: ## Start the stack (Grafana: http://127.0.0.1:13000, OTLP: 127.0.0.1:14317/14318)
	$(COMPOSE_UP) up -d --remove-orphans

lab-down: ## Stop the stack, keep its data
	$(COMPOSE_ALL) stop

lab-status: ## Show the stack's containers
	$(COMPOSE_ALL) ps

lab-logs: ## Follow the stack's logs
	$(COMPOSE_ALL) logs -f

lab-check: ## Run every dashboard query against the stack over the last hour (SINCE=<seconds> to change)
	node scripts/check-dashboards.mjs --since $(or $(SINCE),3600)

lab-nuke: ## Remove the stack's containers, volumes and images
	$(COMPOSE_ALL) down -v --rmi all --remove-orphans

NAME ?= treasury

scenario: ## Run a scenario on its testnet (needs its key in the environment); telemetry to the stack
	OTEL_EXPORTER_OTLP_ENDPOINT=$(LAB_OTLP) pnpm --filter ./scenarios/$(NAME) start

scenario-local: tools ## Run a scenario against a local Anvil with the testnet's chain id; telemetry to the stack
	OTEL_EXPORTER_OTLP_ENDPOINT=$(LAB_OTLP) pnpm --filter ./scenarios/$(NAME) start:local

clean: ## Remove node_modules and .tools
	rm -rf .tools node_modules packages/*/node_modules scenarios/*/node_modules coverage
