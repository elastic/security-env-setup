# Elastic Security test environment CLI

One command to provision a fully populated Elastic Security environment — Elastic Cloud deployment or local stack, Kibana spaces, detection engine initialization, prebuilt rules, custom rules, cases, attack discoveries, entity analytics, endpoint events, and integrations. One command to tear it back down.

```bash
node dist/index.js create   # go from zero to ready-to-use environment
node dist/index.js clean    # remove what this CLI created, keep what you added
```

---

## Problem

Setting up a Security Solution test environment manually involves:

1. Logging into Elastic Cloud (or spinning up a local stack), waiting 10–15 minutes for the deployment or build to become healthy.
2. Copying the Elasticsearch URL, Kibana URL, and generated password somewhere safe.
3. Opening Kibana, creating target spaces one by one.
4. Hitting `POST /api/detection_engine/index` manually (or knowing to do it at all) to initialize the detection engine.
5. Running the prebuilt-rules install via a two-step internal API (`_bootstrap` + `installation/_perform`) — the public API doesn't cover it.
6. Running separate `yarn test:generate` and `node generate_cli.js` commands from inside the Kibana repo, with correctly set environment variables and the right version of Node on `PATH`.
7. If you want attack discoveries, entity analytics, CSP findings, correlated integrations data — cloning `security-documents-generator`, writing its `config.json`, installing its dependencies, running each of its nine subcommands.
8. When you're done, remembering which rules, cases, and spaces came from your tool vs. what was already in Kibana, and deleting them without destroying anything else.

Each of these steps has failure modes. The deployment API is not the same as the Cloud UI. Scripts require knowing which of two different plugin directory layouts your local repo uses. The password from the creation response is never shown again. Kibana's random `basePath` will silently cause every `POST /api/...` call to 404 unless you remember `--no-base-path`.

This tool does all of it in one `create` command, and reverses it in one `clean` command.

## Why It Matters

**QA engineers** running regression cycles need clean environments quickly. Waiting on a colleague to provision one, or navigating the Cloud UI repeatedly, adds friction to every cycle.

**Security Solution developers** who need to demo or test features — attack discoveries, detection rules, cases, entity analytics — need spaces pre-created and the detection engine pre-initialized before sample data can be loaded. That last step is easy to forget.

**New team members** have no documented path from zero to a working Security environment. This tool is that path.

---

## Quick start

```bash
# Install
git clone https://github.com/elastic/security-env-setup.git
cd security-env-setup
npm install
npm run build

# (Elastic Cloud only) configure credentials
node dist/index.js auth login

# Create environment
node dist/index.js create

# Remove what this tool created
node dist/index.js clean
```

## Prerequisites

- **Node.js** on `PATH` (for the CLI itself). Node 18+ is what has been tested; older versions may work but are unverified.
- **Node.js 24+ via nvm** — required by `security-documents-generator` when using the local target's "Extended data" option. The CLI detects this automatically and offers to run `nvm install 24` for you.
- **Elastic Cloud target:** an Elastic Cloud account with an API key that has deployment create/read/delete permissions. Configure it via `auth login`.
- **Local target:** a local clone of [`elastic/kibana`](https://github.com/elastic/kibana), already bootstrapped (`yarn kbn bootstrap` completed). The CLI will verify this at startup and abort with a clear message if bootstrap is missing.

---

## What the tool does

### Two targets, one wizard

`create` asks which environment you want, then collects just the information needed for that path:

- **Elastic Cloud (ECH):** uses your API key to provision a new deployment on prod / qa / staging, waits for it to be healthy, then configures it.
- **Local stateful (self-hosted):** detects or auto-starts Elasticsearch and Kibana from your local Kibana checkout, then configures them.
- **Local serverless:** wizard option exposed but not empirically validated. Requires Docker and `docker.elastic.co` registry access. See "Known limitations".

Both targets follow the same core flow (spaces, detection engine init, prebuilt rules, data-generation choices), with local adding two capabilities ECH does not have: service auto-start via `osascript` and the `security-documents-generator` pipeline for richer sample data.

### Data-generation choices

A `checkbox` prompt lets the user pick which sample data to generate. The three shared options are identical in both targets; local adds a fourth option for extended data.

- **Alerts + Attack Discoveries** — runs `generate_cli.js --attacks`; creates rules and their matching alerts.
- **Cases** — in ECH, runs `generate_cases.js` for ~1000 cases in default + 300 per additional space. In local, cases are generated together with alerts by the same script (the wizard tells the user this up front).
- **Events** — runs `yarn test:generate` for endpoint resolver trees; always writes to the default space (the script does not support `--spaceId`).
- **Extended data** _(local only)_ — runs the full nine-command `security-documents-generator` pipeline: correlated org data, detection rules, 10 000+ alerts, entity analytics, asset criticality, ML anomaly insights, privileged user monitoring, cloud security posture findings.

Nothing is generated unless it's selected. If the checkbox is left empty, `create` still provisions the deployment, spaces, and prebuilt rules — just no sample data.

### `clean` — remove what you created

`clean` scans the environment for resources this CLI (or the scripts it orchestrates) created, and deletes them interactively:

- **Custom detection rules** (`immutable: false`) — checkbox list, all pre-selected.
- **Cases tagged `data-generator`** — confirm prompt.
- **Non-default Kibana spaces** — checkbox list, none pre-selected (safer default).

Prebuilt rules, alert datastreams, and anything not explicitly created by this tool are never touched.

```bash
node dist/index.js clean             # interactive
node dist/index.js clean --dry-run   # preview, no deletions
node dist/index.js clean --yes       # no confirmation prompt (CI)
node dist/index.js create --clean    # clean first, then provision
```

---

## Example output

<details>
<summary><b>Local stateful — selecting "nothing" (minimal run, ~1 minute)</b></summary>

```
[1/5] Running deployment wizard…
? What kind of environment do you want to create? Local stateful (self-hosted)
? Path to your Kibana checkout: /Users/vgomez/Documents/Kibana/kibana
? Kibana URL: http://localhost:5601
? Elasticsearch URL: http://localhost:9200
? Username: elastic
? Password: ********
? Kibana space ID: default
? Data volume: medium — ~10k alerts, 10 hosts, 10 users (recommended)
? Generate sample data (select any, note: Alerts and Cases are generated together in local):
? Install Kibana sample data (flights, ecommerce, logs)? No

[1/11] Checking Node 24 via nvm…
Node v24.15.0 found via nvm — preflight check passed.
[2/11] Checking Kibana bootstrap…
[3/11] Ensuring Kibana and Elasticsearch are running…
Services already running.
[4/11] Installing Kibana sample data…
Sample data installation skipped.
[5/11] Creating Kibana space…
Using default space — no space creation needed.
[6/11] Initializing Security Solution detection engine…
✔ Security Solution index initialized successfully.
[7/11] Installing prebuilt detection rules…
Installed 1779/1779 prebuilt rules (3 Fleet packages synced).
[8/11] Running Kibana internal data generator…
Alerts + Cases generation skipped (not selected).
[9/11] Running Kibana endpoint event generator (resolver trees)…
Events generation skipped (not selected).
[10/11] Setting up security-documents-generator…
Extended data (docs-generator) skipped (not selected).
[11/11] Done!

────────────────────────────────────────────────────────────
  Local Environment Ready
────────────────────────────────────────────────────────────
  Target            local-stateful
  Kibana            http://localhost:5601
  Elasticsearch     http://localhost:9200
  Space             default
  Rules             1779 installed (enable from Rules UI)
  Alerts + Cases    skipped
  Events            skipped
  Extended data     skipped
────────────────────────────────────────────────────────────
```

_`[1/5]` is the overall wizard; once a local target is chosen, the flow delegates to an 11-step local pipeline with its own counter. Both are visible, distinct phases._
</details>

<details>
<summary><b>Elastic Cloud — full data generation</b> <i>(output snapshot to be refreshed after the next live run)</i></summary>

```
[1/5] Running deployment wizard…
[2/5] Creating deployment "sec-final-demo" on prod…
[3/5] Waiting for deployment to become healthy…
✔ Deployment is healthy and running.
[4/5] Creating Kibana spaces…
✔ Space "Security" created successfully.
✔ Space "Staging" created successfully.
[5/5] Initializing Security Solution…
✔ Security Solution index initialized successfully.
Kibana dependencies not found. Running yarn kbn bootstrap…
Done in 14.36s.
✔ Generating alerts & attack discoveries — done
✔ Generating events — done
✔ Generating cases — done
✔ Generating alerts & attack discoveries — done (space: security)
✔ Generating cases — done (space: security)

────────────────────────────────────────────────────────────
  Deployment Ready
────────────────────────────────────────────────────────────
  Name          sec-final-demo
  Environment   prod
  Kibana        https://a86ee5dac90347098786348e1a394a31.us-west2.gcp.elastic-cloud.com:443
  Elasticsearch https://c1eed76c8e424c378e3117f8b977de78.us-west2.gcp.elastic-cloud.com:443
  Username      elastic
  Password      ••••••••••••••••••••
  Spaces        Security, Staging
  Data spaces   default, security
────────────────────────────────────────────────────────────
  Keep your password safe — it will not be shown again.
```
</details>

<details>
<summary><b><code>clean --dry-run</code> on a populated local environment</b></summary>

```
? What kind of environment do you want to clean? Local stateful (self-hosted)
? Kibana URL: http://localhost:5601
? Elasticsearch URL: http://localhost:9200
? Username: elastic
? Password: ********
? Kibana space ID: default

Clean plan for http://localhost:5601 (space: default):
  • 11 custom detection rules
  • 9 cases with tag "data-generator"
  • 0 non-default Kibana spaces

Dry run — nothing will be deleted.
```
</details>

---

## Commands reference

<details>
<summary><b><code>auth login</code> / <code>auth status</code> / <code>auth logout</code></b></summary>

Configures Elastic Cloud API credentials. Only needed for the ECH target.

```bash
node dist/index.js auth login    # validates the key against the Cloud API before saving
node dist/index.js auth status   # shows which environments have a configured key
node dist/index.js auth logout   # removes the stored key for an environment
```

Keys are stored at `~/.security-env-setup/config.json` (via [`conf`](https://www.npmjs.com/package/conf)).
</details>

<details>
<summary><b><code>create</code></b></summary>

Interactive wizard. The exact prompts depend on the chosen target.

**Flags:**

- `--clean` — run `clean` with the same wizard answers before provisioning.
- `--dry-run` — meaningful only with `--clean`; previews what clean would delete and exits without provisioning.
- `--yes` — skip clean's final confirmation prompt (useful in CI).

```bash
node dist/index.js create
node dist/index.js create --clean           # wipe, then reprovision
node dist/index.js create --clean --dry-run # preview clean, don't provision
node dist/index.js create --clean --yes     # automated iteration
```
</details>

<details>
<summary><b><code>clean</code></b></summary>

Removes resources created by this CLI. Scans the environment first, then presents selection prompts per category.

**Flags:**

- `--dry-run` — prints the plan, deletes nothing, exits 0.
- `--yes` — skips the final `[y/N]` "Proceed?" confirmation (the per-category selection prompts still run).

```bash
node dist/index.js clean
node dist/index.js clean --dry-run
node dist/index.js clean --yes
```

**Deletion scope:**

- Custom detection rules (`immutable: false`) — user-selected via checkbox.
- Cases with tag `data-generator` — all-or-nothing confirm.
- Non-default Kibana spaces — user-selected via checkbox, none pre-checked.

Prebuilt rules, shared alert datastreams, Fleet packages, and anything not explicitly created by this tool are never touched.
</details>

---

## Architecture

<details>
<summary><b>Project layout</b></summary>

```
src/
  api/
    cloud.ts             Elastic Cloud REST API client (create, wait, list, delete deployments)
    kibana.ts            Kibana Spaces API, Security Solution init, detection engine rules,
                         cases, sample data — the public surface consumed by all commands

  commands/
    auth.ts              auth login / status / logout
    create.ts            ECH create orchestration; delegates to create-local for local targets
    create-local.ts      local stateful / serverless orchestration (11 steps)
    clean.ts             clean subcommand + runCleanCore entry point reused by create --clean

  wizard/
    prompts.ts           runWizard (ECH), runLocalPrompts (local), runCleanPrompts (clean) —
                         all interactive inquirer flows with inline validation

  runners/
    scripts.ts           spawns Kibana data-generation scripts as child processes;
                         detects plugin directory layout; credentials via environment variables
    local-services.ts    osascript auto-start for Kibana + Elasticsearch on macOS, assisted
                         fallback elsewhere; detects basePath-misconfigured Kibana
    docs-generator.ts    clones, bootstraps, and runs security-documents-generator with its
                         nine-command standard sequence, each capped at a 3-minute timeout

  config/
    store.ts             reads and writes API keys to ~/.security-env-setup/config.json
    endpoints.ts         maps environment names to Elastic Cloud API base URLs
    volume-presets.ts    small/medium/large presets for data-volume scaling

  types/
    index.ts             all shared interfaces; no `any`, explicit return types throughout

  utils/
    errors.ts            normalises unknown thrown values to strings
    http.ts              builds Elastic Cloud ApiKey authorization headers
    logger.ts            coloured console output (info, success, warn, error, step)
    retry.ts             generic retry loop with configurable delay, backoff, shouldRetry
    node-version.ts      nvm version detection for the Node 24 preflight check

tests/                   mirrors src/ layout; 572 tests, 17 suites, ≥85% branch coverage
```
</details>

<details>
<summary><b>Design principles followed throughout</b></summary>

- **Empirical verification over documentation.** Every Kibana endpoint used here was tested with live `curl` against a populated Kibana before code was written. The public docs contradicted the installed API surface in several places; when they disagreed, the running server won. Notable: the prebuilt-rules install uses a two-step internal API (`_bootstrap` + `installation/_perform`), not the documented public one. `POST /api/cases/_bulk_delete` is documented but does not exist in this Kibana version; the tool uses `DELETE /api/cases?ids=<json>` instead.

- **Strict TypeScript.** `strict: true`, `noImplicitAny`, explicit return types on every exported function, zero `any` in production code. ESLint with `@typescript-eslint/strict-type-checked`.

- **Surgical changes.** Each feature stage touches only the files it needs. No drive-by refactors. When ugly code is found in a file being modified, it's left alone unless fixing it is in scope.

- **Resilient over dogmatic.** Individual generator failures are swallowed as warnings so the sequence completes; the user sees what worked and what didn't, instead of the flow dying on the first hiccup. Infrastructure failures (bootstrap missing, services down, clone fails) propagate as hard errors.

- **Honest UI.** The local-target data-generation checkbox tells the user in the prompt message that alerts and cases are generated together, because the underlying script produces both in one pass. The CLI does not hide constraints behind optimistic abstractions.

- **Credentials never logged.** Axios error objects contain request headers; they're never logged wholesale. Only `error.message` and `error.response?.status` are surfaced.

- **Idempotent where possible.** `writeConfig`, `ensureRepoCloned`, `ensureServicesRunning` all safe to re-run. `createSpace` treats 409 as "already exists" and continues.
</details>

<details>
<summary><b>Deployment payload — why it looks the way it does</b></summary>

The Elastic Cloud deployment payload uses hardcoded but API-verified instance configuration IDs per cloud provider (GCP, AWS, Azure). The `gcp-storage-optimized` template ID is used for all providers — the name is misleading; it is the template the API accepts. This was discovered empirically after the "dynamic template fetching" approach returned stale data from the templates API. The verified payload structure lives in `src/api/cloud.ts`.

The `POST /api/v1/deployments` response returns `resources` as a flat array with a `kind` discriminant, not as an object keyed by resource type. Earlier iterations of the code assumed the keyed shape and lost the generated password silently. The current `CreateDeploymentApiResponse` interface models the flat-array shape, and `waitForDeployment` extracts credentials by filtering `kind`.
</details>

---

## How Claude Code helped

<details>
<summary><b>Scaffolding, typing, and structural work</b></summary>

**Scaffolding from scratch.** The project structure — `src/api/`, `src/commands/`, `src/wizard/`, `src/runners/`, `src/config/`, `src/types/`, `src/utils/` — was laid out with Claude Code before any product code existed. Package selection, `tsconfig.json` strictness settings, and ESLint configuration were all generated and verified in the first session.

**Type system.** Every interface — `LocalWizardAnswers`, `DeploymentConfig`, `CleanAnswers`, `CleanResult`, `DocsGeneratorConfigOptions`, and many more — was designed iteratively with Claude Code, reshaping them as new requirements forced changes. No `any`; where a type genuinely couldn't be expressed, `unknown` + type guards was the fallback.

**254 → 572 tests.** Starting from 254 tests at the end of the ECH-only phase, Claude Code added 318 more tests across the local, clean, and parity stages. The test patterns used — extracting validators from `inquirer.prompt` call arguments and testing them directly; extracting `shouldRetry` callbacks from `retry` mock calls; simulating child-process `error` and `close` events by invoking registered listeners — were established by Claude Code and followed consistently.
</details>

<details>
<summary><b>Runtime debugging against live systems</b></summary>

**The flat-resources bug.** The `POST /api/v1/deployments` response returns `resources` as a flat array with a `kind` discriminant — not as an object keyed by resource type. Claude Code traced the credential flow from `createDeployment` through `waitForDeployment` to `createSpaces`, identified exactly where `password` was being extracted from the wrong shape, and rewrote the `CreateDeploymentApiResponse` interface and extraction line in one pass.

**Kibana's random basePath.** Running against a Kibana started without `--no-base-path` produced 404s on every `POST /api/...`. Claude Code diagnosed it from a captured 302 redirect, added `probeKibana` with `maxRedirects: 0`, and built `detectServices` as a discriminated union (`ok | kibana-basepath`) so callers abort with an actionable message instead of retrying blindly.

**The four real API issues fixed in a single afternoon.**
1. `generate_cli.js` reading `--password` from CLI flags rather than the `ELASTICSEARCH_PASSWORD` environment variable — found in its source, not its docs.
2. Trailing slashes re-added by `new URL().toString()` after normalization.
3. Port 443 needing replacement with 9243 for `yarn test:generate`'s internal proxy.
4. `NODE_TLS_REJECT_UNAUTHORIZED=0` causing `yarn test:generate` to print a warning and terminate immediately.

**Prebuilt rules install migration.** Partway through development, the public `POST /api/detection_engine/rules/prepackaged` endpoint stopped returning results. Claude Code identified the replacement — a two-step `_bootstrap` + `installation/_perform` internal API — verified it with `curl`, and migrated `installPrebuiltRules` with appropriate headers (`x-elastic-internal-origin: Kibana`, `elastic-api-version: 1`) and a 5-minute timeout to accommodate fresh-Kibana warmup.
</details>

<details>
<summary><b>Architectural decisions surfaced through dialogue</b></summary>

**`clean` scope.** The initial instinct was to delete "everything the tool created". Claude Code surfaced the problem: without tagging, the tool can't distinguish its own spaces from a user's. Three levels were proposed — minimum-safe (A), medium (B), aggressive (C) — and the discussion converged on Level A by default, with the user deciding via interactive checkboxes for rules and spaces, and a tag-based filter for cases (`tags=data-generator` query). This protects users with shared environments from accidental destruction.

**ECH-local parity asymmetry.** When adding the `dataChoices` checkbox to the local flow for parity with ECH, Claude Code surfaced an inconvenient truth: `generate_cli.js --attacks` in local generates alerts AND cases together, so "Cases" and "Alerts" aren't truly independent options there. Three UX options were proposed; the chosen one surfaces the asymmetry to the user directly in the prompt message, rather than hiding it.

**Empirical verification before implementation.** Stage 4.14 (clean) was preceded by six live `curl` calls against a populated Kibana to verify every endpoint and query syntax the prompt would instruct Claude Code to use. The `/api/cases/_bulk_delete` endpoint, which the public Kibana docs appear to reference, turned out not to exist in this version; `DELETE /api/cases?ids=<json>` was confirmed working instead. Writing the implementation on top of documented-but-nonexistent endpoints would have wasted hours of iteration.
</details>

<details>
<summary><b>Iteration style</b></summary>

**Prompts iterated before execution.** The `clean` prompt went through three versions, each one critiqued against its predecessor. V1 had flag-combination contradictions; V2 fixed those but introduced redundant type definitions; V3 resolved both and added explicit error-handling policy for per-chunk vs. per-category failures. This "write, reread, fix, repeat" loop caught issues that would have required multiple implementation iterations to find.

**Copilot as reviewer.** After each PR was opened, GitHub's Copilot Code Review was invoked with "apply changes based on the comments in this thread". It caught inconsistencies (step-label mismatches, missing `cd` quoting in assisted-mode instructions, under-tested warning behavior on `create --clean` flags) and committed fixes directly to the PR branch. The reviewer cycle took minutes rather than days.
</details>

---

## Development

```bash
npm install        # install dependencies
npm run build      # compile TypeScript → dist/
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
npm run format     # Prettier
npm test           # Jest (572 tests, 17 suites)
npm test -- --coverage
```

Branch coverage ≥ 85% globally, with `create-local.ts` at 100% across every metric after the most recent stage. Coverage thresholds are enforced in CI.

---

## Known limitations

- **Local serverless is not empirically validated.** The wizard offers the option but the end-to-end flow has not been tested against a live serverless stack. Requires a Docker daemon capable of pulling from `docker.elastic.co`, which itself requires Elastic-internal registry credentials not always available by default. If you have both, the flow runs the same provisioning as local stateful — but it has not been verified against a real serverless Kibana.

- **Alerts in additional spaces (ECH).** `generate_cli.js --attacks` generates alerts via rule preview and copies them to the default space. When run against a custom space, the 15 prebuilt rules are installed and enabled but alerts may not appear immediately — the rules need to execute against existing data. Alerts in the default space are always generated correctly.

- **Events are default-space only.** `yarn test:generate` does not support `--spaceId`. Events are always generated in the default space regardless of the space selection.

- **Kibana must be started with `--no-base-path` in local.** Kibana's dev server generates a random URL prefix (basePath) by default, which causes all `POST /api/...` calls to 404. When the tool auto-starts Kibana it passes `--no-base-path` automatically. If you start Kibana yourself before running `create`, include the flag: `yarn start --no-base-path`. The tool detects a running Kibana with a basePath and aborts with an actionable error.

- **`clean` is Level A only.** Elasticsearch index-level deletion (`auditbeat-8.12.0-*`, `.ml-anomalies-*`, endpoint event datastreams) is deliberately not implemented. A future `--deep-clean` flag is scoped but out of current release.

- **Docker registry auth is not documented in-tool.** If local serverless ever fails with `denied: requires authentication`, run `docker login docker.elastic.co` with your Elastic-internal credentials before launching.
