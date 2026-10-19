# search-optimizer

Search-conversion agent for dashboard-server stores. It connects to each store's own search context — the merchant's settings, catalog, and every search, click, add-to-cart and order the storefront logs — finds where search loses buyers, and leaves the store with reviewable actions that fix it. It then measures what happened.

The agent works like tenant-studio's studio agent, adapted to live stores. It starts from a whole-store workspace, uses read-only analytics tools, runs a guarded set of change tools and ends every run with a structured, grounded report. The difference: tenant-studio edits a draft search module it can re-run locally, whereas here every lever touches production. So search changes wait for human approval, and catalog repairs execute only where the store's policy allows it.

## What a run does

1. **Data report** (deterministic, no model calls, read-only on the store) — `src/analytics/`:
   - **Funnel** over distinct sessions: searched → clicked (30 min) → carted (2 h) → checkout / purchased (24 h). Orders, recorded revenue by currency, and the share that followed a search. It also compares purchase rates for carting sessions that searched against those that didn't.
   - **Per-query conversion** with explicit attribution (the event's `search_query`) or inferred attribution (the last search in the same session, within the stage window). Every query gets a **leak stage** (zero results / shown not clicked / clicked not carted / carted not bought) judged against the store's own funnel, plus **sessions below average**, a size for triage rather than a forecast.
   - **Production baseline**: queries that work today (shoppers clearly choose products), queries that fail, and **catalog gaps**, where shoppers want products that are missing, hidden or out of stock and no ranking rule can help.
   - **Audit candidates**, interleaved by failure mode so no single kind crowds out the rest.
   - **Tracking issues**: what limits the numbers, in Hebrew with the fix. Searches without `session_id`, no purchase tracking, order sessions that don't match browsing sessions, logging gaps, event product ids that don't match the catalog, automated queries (excluded from baselines), and experiments that barely get exposure.
2. **Agent** (`src/agent/`, Claude Agent SDK) starts with WORKSPACE and DATA — the store's production settings, rules and experiments live in search, open work and measured outcomes, rejected proposals, previous reviews, and earlier operator requests. It then:
   - digs in: `customer_analytics`, `store_funnel`, `query_evidence` (shown vs chosen products, with availability), `search_audit`, `production_baseline`, and catalog tools;
   - acts: catalog repairs, targeted reprocess and investigations (`create_optimization_action`; executes only under `autoExecuteCatalog`), permanent rules (`propose_rule`) and A/B experiments (`propose_experiment`), both human-approved;
   - closes the loop: failure queue, diagnoses, verification of submitted jobs, experiment readouts;
   - ends with `submit_conversion_report`: findings, prioritized proposals (evidence, exact queries, change, expected impact as a hypothesis, metric, validation and rollback, risk, linked action and proposal ids), and limitations. It also writes a Hebrew review.

### Guardrails

- A report can only cite queries the run actually saw in the store's data, and only action or proposal ids that exist in the store. Otherwise it is rejected and the agent must fix it.
- Pins must point at visible, in-stock catalog products. Soft-category boosts must use labels that exist. Category association is never global. A change touching queries that already work lists them, with the products shoppers choose there, for the reviewer.
- Permanent rules must target specific queries. Global boosts and personalization weights need an experiment.
- At most 6 experiment/rule proposals per run. Per-run and monthly budgets (`AGENT_RUN_BUDGET_USD`, `AGENT_MONTHLY_BUDGET_USD`). One run per store at a time.
- Runs return immediately. Every tool call streams into `agent_runs.steps`. The operator can stop a run, and runs killed by a restart are marked interrupted, which releases the store's lock.

## Architecture

- **This repo**: Fastify API, crons and the agent runner, plus the React ops UI, in one process on `:4400`. Control data lives in Mongo db `control_plane` (`conversion_reports`, `agent_runs`, `optimization_actions`, `proposals`, `experiments`, `rules`, `experiment_metrics`). Tenant data (`queries`, `product_clicks`, `cart`, `checkout_events`, `zero_searches`, `products`, `experiment_exposures`) is read from each store's database; catalog repairs are the only tenant writes.
- **dashboard-server** applies experiments and rules through `experiments-hook.mjs`, from Redis keys `experiments:active:{apiKey}` / `rules:active:{apiKey}`. It logs exposures and **falls back to control on any failure**. It enrolls a shopper only when the search request carries `session_id`.

Assignment: `fnv1a32(experimentId + ':' + sessionId) % 10000`, sticky and storage-free, and identical in `src/core/assignment.ts` and the hook (`test/m1-verify.test.ts`).

## Run

```bash
npm install
# .env: MONGODB_URI, REDIS_URL, ANTHROPIC_API_KEY, OPS_PASSWORD (basic auth; unauthenticated if unset), PORT=4400
# optional: AGENT_MODEL (default claude-fable-5), AGENT_EFFORT (model default), AGENT_RUN_BUDGET_USD (2), AGENT_MONTHLY_BUDGET_USD (20), AGENT_MAX_TURNS (45), AGENT_RUN_TIMEOUT_MIN (50), REPROCESS_SERVICE_URL
npm run ui:build   # ops UI into ui/dist (served by the API; rebuild before start)
npm start          # API + crons on :4400
```

Crons: Redis active keys every 30 s · reprocess reconciliation every 2 min · interrupted-run recovery every 5 min · experiment metrics hourly · daily store policies hourly check · agent for stores without a daily policy when `AGENT_NIGHTLY=true` (every `AGENT_INTERVAL_DAYS`) · proposal expiry daily.

## Ops flow

1. **Conversion** — pick a store: funnel, tracking issues, biggest leaks, audit candidates, baseline and catalog gaps, and the latest agent report. Refresh the data, or run the agent with an optional focus request ("תתמקד בחיפושים שמגיעים לסל ולא נקנים") and follow its steps live; the page also lets you stop a run.
2. **Opportunities** — approve or reject experiments, permanent rules and legacy catalog-filter proposals, with guard warnings and the queries a change must protect.
3. **Daily optimization** — the repair queue: execute, verify or dismiss catalog actions, and set the store's daily policy.
4. **Experiments** — per-arm funnel with click, conversion and revenue readouts. Pause, complete, kill or promote.
5. **Merchandising** — permanent rules.

## API

- `GET /api/conversion?tenant=` returns the latest data report, the agent report (with the live status of linked actions and proposals), the store profile and the latest run. `POST /api/conversion/refresh?tenant=&days=` rebuilds the data report.
- `POST /api/agent/run?tenant=` with `{request?}` returns `{runId}` at once. `GET /api/agent/runs/:id` returns the steps and status. `POST /api/agent/runs/:id/stop` stops the run. `GET /api/agent/runs`, `GET /api/agent/spend`.
- Experiments, proposals (approving a `rule` proposal activates it), rules, optimization actions and policy, debug Redis: see `src/api/routes/`.

## Verification

- `npm test` — attribution and funnel math (every timestamp shape, `checkout_completed` only, order dedupe), leak stages and automated-query detection, catalog matching, baseline and gap classification, tracking issues, guards, report grounding. It also covers the failure queue and the assignment parity with the hook.
- `npx tsx scripts/verify-metrics.ts` — synthetic funnel → aggregator output (creates and drops `so_metrics_test_db`).

## Known limitations

- The agent cannot re-run a store's live search to verify a change, because dashboard-server logs every `/search` call into the store's analytics. Evidence comes from `queries.deliveredProducts` (≤20 names per search) and post-change measurement. A no-log probe header in dashboard-server would enable a closed verification loop like tenant-studio's.
- Inferred attribution is evidence, not proof. Stores without session ids on searches, or without `checkout_completed`, cannot be measured to purchase; the report says so rather than showing zeros.
- Reads are bounded (120k events per source per window). A truncated source is reported, and a shorter window should be used.
- Boost experiments affect `scoreProductLineResult` only. Start/kill propagation lags up to ~45 s.
