# security-env-setup

CLI tool that provisions a full Elastic Security QA environment — Cloud deployment, Kibana spaces, and sample data — in a single interactive command.

## Problem

Setting up a Security Solution test environment manually involves:

1. Logging into Elastic Cloud and navigating the deployment creation UI
2. Waiting 10–15 minutes for the deployment to become healthy
3. Copying the Elasticsearch URL, Kibana URL, and generated password somewhere safe
4. Opening Kibana, switching to each target space, and creating them one by one
5. Hitting `POST /api/detection_engine/index` manually (or knowing to do it at all) to initialize the detection engine
6. Running separate `yarn test:generate` and `node generate_cli.js` commands from inside the Kibana repo, having first set a handful of environment variables correctly

Each of these steps has failure modes. The deployment API is not the same as the Cloud UI. The Kibana scripts require knowing which of two different plugin directory layouts your local repo uses. The password from the creation response is never shown again.

This tool does all of it in one `create` command.

## Why It Matters

**QA engineers** running regression cycles need a clean environment quickly. Waiting on a colleague to provision one, or navigating the Cloud UI repeatedly, adds friction to every cycle.

**Security Solution developers** who need to demo or test features — attack discoveries, detection rules, cases — need spaces pre-created and the detection engine pre-initialized before sample data can be loaded. That last step is easy to forget.

**New team members** have no documented path from zero to a working Security environment. This tool is that path.

## Language Used

The tool is written in **TypeScript** (strict mode, no `any`, explicit return types throughout). Coming from Python and Markup backgrounds, TypeScript is a genuine stretch: the type system is structural, the async model is callback-and-Promise-based rather than synchronous, and the toolchain (tsc, ESLint with `@typescript-eslint/strict`, Jest with ts-jest) requires upfront configuration before a single line of product code runs.

TypeScript fits this use case better than Go because the npm ecosystem already contains the right building blocks — `commander` for CLI parsing, `inquirer` for interactive prompts, `axios` for HTTP, `ora` for spinners — and interoperating with Kibana's existing Node.js data-generation scripts is much simpler from the same runtime. A Go binary would need to shell out to Node anyway.

## How Claude Code Helped

**Scaffolding from scratch.** The project structure — `src/api/`, `src/commands/`, `src/wizard/`, `src/runners/`, `src/config/`, `src/utils/` — was laid out with Claude Code before any product code existed. Package selection, `tsconfig.json` strictness settings, and ESLint configuration were all generated and verified in the first session.

**Generating API client code.** The Elastic Cloud REST API has a complex, provider-specific deployment payload. Claude Code helped write the `createDeployment` function iteratively: starting with a dynamic template-fetching approach, then switching to a hardcoded verified payload structure after the templates API returned stale data.

**Debugging the flat resources array bug.** The `POST /api/v1/deployments` response returns `resources` as a flat array with a `kind` discriminant — not as an object keyed by resource type. Claude Code traced the credential flow from `createDeployment` through `waitForDeployment` to `createSpaces`, identified exactly where `password` was being extracted from the wrong shape, and rewrote the `CreateDeploymentApiResponse` interface and extraction line in one pass.

**Writing 199 tests with 86%+ branch coverage.** Starting from ~80% coverage, Claude Code identified uncovered branches from Istanbul output, wrote targeted tests for each one — validator callbacks extracted from `inquirer.prompt` call arguments, `shouldRetry` logic in the polling loop, error path edge cases in script runners — and updated mocks whenever the underlying interface changed.

**Iterating on review feedback.** After each round of pull request feedback, Claude Code applied corrections (unused imports, missing edge-case tests, inconsistent error messages) without touching unrelated code. The constraint "only change what was asked" was respected throughout.

## Prerequisites

- Node.js 18 or later
- An Elastic Cloud account with an API key that has deployment create/read/delete permissions
- _(Optional)_ A local clone of the [Kibana repository](https://github.com/elastic/kibana) — required only for the data generation step

## How to Run

```bash
# Install
git clone https://github.com/elastic/security-env-setup.git
cd security-env-setup
npm install
npm run build

# Configure credentials
node dist/index.js auth login

# Create environment
node dist/index.js create
```

## Example Output

```
[2/5] Creating deployment "security-test-1234" on prod…
[3/5] Waiting for deployment to become healthy…
✔ Deployment is healthy and running.
[4/5] Creating Kibana spaces…
✔ Space "Security" created successfully.
[5/5] Initializing Security Solution…
✔ Security Solution index initialized successfully.

────────────────────────────────────────────────────────────
  Deployment Ready
────────────────────────────────────────────────────────────
  Name          security-test-1234
  Environment   prod
  Kibana        https://5cdff87635c34d638858c14a2b5de497.kb.us-west2.gcp.elastic-cloud.com:443
  Elasticsearch https://a0e8836c1a784867a42e3ed4fef04418.es.us-west2.gcp.elastic-cloud.com:443
  Username      elastic
  Password      ••••••••••••••••••••
  Spaces        Security
────────────────────────────────────────────────────────────
  Keep your password safe — it will not be shown again.
```

## Commands Reference

### `auth login`

Prompts for a target environment (`prod`, `qa`, or `staging`) and an API key. Validates the key against the Cloud API before saving it to disk.

```bash
node dist/index.js auth login
```

### `auth status`

Shows which environments have a configured API key.

```bash
node dist/index.js auth status
```

### `auth logout`

Removes the stored API key for a selected environment.

```bash
node dist/index.js auth logout
```

### `create`

Starts the interactive five-step wizard:

1. **Deployment name and environment** — alphanumeric + hyphens, targeting prod / qa / staging
2. **Region** — filtered to regions available in the selected environment
3. **Stack version** — semver, defaults to `8.17.1`
4. **Kibana spaces** — 1–10 spaces, names converted to hyphenated IDs
5. **Sample data** — optionally generate Alerts + Attack Discoveries, Cases, and/or Events using scripts from a local Kibana repo

```bash
node dist/index.js create
```

Data generation is skipped entirely if no Kibana repo path is provided (or if the path is left empty at the prompt). The deployment and spaces are still created.

## Architecture

```
src/
  api/
    cloud.ts      — Elastic Cloud REST API client (create, wait, list, delete deployments)
    kibana.ts     — Kibana Spaces API and Security Solution initialization
  commands/
    auth.ts       — auth login / status / logout command handlers
    create.ts     — create command; orchestrates all five steps
  wizard/
    prompts.ts    — interactive inquirer prompts with inline validation
  runners/
    scripts.ts    — spawns Kibana data-generation scripts as child processes;
                    detects new vs. old plugin directory layout automatically;
                    passes credentials via environment variables, never CLI args
  config/
    store.ts      — reads and writes API keys to ~/.config/security-env-setup/config.json
    endpoints.ts  — maps environment names to Elastic Cloud API base URLs
  utils/
    errors.ts     — normalises unknown thrown values to strings
    http.ts       — builds Elastic Cloud ApiKey authorization headers
    logger.ts     — coloured console output helpers (info, success, warn, error, step)
    retry.ts      — generic retry loop with configurable delay, backoff, and shouldRetry
```

The deployment payload is built using hardcoded but API-verified instance configuration IDs per cloud provider (GCP, AWS, Azure). The `gcp-storage-optimized` deployment template ID is used for all providers — the name is misleading; it is the template the API accepts.

## Running Tests

```bash
npm test
npm test -- --coverage
```

199 tests across 12 test suites. Branch coverage is above 86%.

Test patterns used throughout:
- Validator and filter functions are extracted from `inquirer.prompt` call arguments and tested directly, bypassing the mock
- `shouldRetry` callbacks in the polling loop are extracted from `retry` mock call arguments
- Child process `error` and `close` events are simulated by calling the registered listeners directly on the spawned process mock
