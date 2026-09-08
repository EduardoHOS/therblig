# Treadle. `make dev` runs the whole thing: the Studio, and the core it imports in process.
#
# There is no backend daemon to start alongside it. The core is a library, the CLI is a command,
# and the MCP server speaks stdio to whatever client spawned it — so "running the backend" is the
# Studio importing it, plus `make check` proving it still holds.

# `npm` is not always on PATH: a bare `node` symlink, or a version manager that shims only node,
# is enough for a recipe — or an npm script chaining `npm run ...` — to die with ENOENT. The npm
# that ships beside the running Node always is: call it by full path, because make execs a simple
# recipe itself and never sees the PATH it exports, and export that directory too, because the
# scripts npm then runs look `npm` up the ordinary way.
NODE ?= node
NODE_BIN := $(shell $(NODE) -p "require('node:path').dirname(process.execPath)" 2>/dev/null)
ifneq ($(NODE_BIN),)
export PATH := $(NODE_BIN):$(PATH)
endif

NPM ?= $(if $(wildcard $(NODE_BIN)/npm),$(NODE_BIN)/npm,npm)
PORT ?= 3000
WORKSPACE ?= $(CURDIR)

.DEFAULT_GOAL := help
.PHONY: help dev install check test lint types coverage corpus build mcp clean

help:                     ## What each target does
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'

dev: node_modules types/core/index.d.mts         ## The Studio on PORT (default 3000), restarting when backend/ changes
	PORT=$(PORT) TREADLE_WORKSPACE=$(WORKSPACE) $(NODE) scripts/dev.mjs

install: node_modules     ## Install both workspaces from the lockfile

check: node_modules       ## The gate: lint, types, tests with 100% core coverage, corpus, replay
	$(NPM) run check

test: node_modules        ## The test suite alone
	$(NPM) test

lint: node_modules        ## oxlint over backend/, bench/ and scripts/
	$(NPM) run lint

types: node_modules       ## Emit the .d.mts contracts and typecheck their consumer
	$(NPM) run types

coverage: node_modules    ## Tests with the 100% core coverage thresholds enforced
	$(NPM) run test:coverage

corpus: node_modules      ## Score every fixture in bench/corpus
	$(NPM) run corpus

build: node_modules       ## Emit the contracts, then build the Studio — leaves a running dev alone
	$(NPM) run types
	NEXT_DIST_DIR=.next-build $(NPM) run build --workspace @therblig/studio

mcp: node_modules         ## The MCP server on stdio — for a client to spawn, not for a terminal
	$(NODE) backend/mcp/server.mjs

clean:                    ## Remove build output; leaves node_modules and the lockfile alone
	rm -rf frontend/.next frontend/.next-build coverage types

# The Studio imports the core's types, and `make clean` removes them, so emit them when they are
# missing or older than the core they are emitted from.
types/core/index.d.mts: $(wildcard backend/core/*.mjs) $(wildcard backend/core/blocks/*.mjs)
	$(NPM) run types

# npm ci wipes and reinstalls, so it runs only when the lockfile or a manifest is newer.
node_modules: package-lock.json package.json frontend/package.json
	$(NPM) ci
	@touch node_modules
