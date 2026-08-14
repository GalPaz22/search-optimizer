# search-optimizer

Agentic search-revenue optimization control plane for dashboard-server tenants.

A Claude agent analyzes each tenant's search analytics (queries, clicks, add-to-carts, orders), proposes ranking modifications — product **boosts**, per-query **pins**, **soft-category weight** changes, **personalization weight** tuning — and, after human approval in the ops UI, runs them as deterministic A/B experiments measured on CTR → add-to-cart → conversion → revenue/session.

## Architecture

- **This repo**: Fastify API + cron + Claude Agent SDK runner + React ops UI, one process on `:4400`. Data in Mongo db `control_plane` (same Atlas cluster as dashboard-server) + tenant-local `experiment_exposures` / `session_aliases` collections.
- **dashboard-server**: only a thin hook — `experiments-hook.mjs` (`applyExperimentVariant`) patches the store config per request from Redis key `experiments:active:{apiKey}`, logs exposures, and **falls back to control on any failure** (Redis down, parse error, anything). Six insertion points: /search, /fast-search, /simple-search (before the pinned-results block), `scoreProductLineResult` boost term, `calculateProfileBoost` return, /profile/merge (session alias).

## Assignment model

`fnv1a32(experimentId + ':' + sessionId) % 10000` → sticky, deterministic, storage-free. Enrollment = `bucket < trafficPct*100`; arm by cumulative weights. First-exposure attribution via unique index `{experiment_id, session_id}`. Login id-rewrites (`/profile/merge`) are unified through `session_aliases`; a `contaminationRate` is reported per experiment. The implementation must stay behaviorally identical in `src/core/assignment.ts` and `../dashboard-server/experiments-hook.mjs` (covered by `test/m1-verify.test.ts`).

## Run

```bash
npm install
# .env: MONGODB_URI, REDIS_URL, ANTHROPIC_API_KEY, OPS_PASSWORD (basic auth; unauthenticated if unset), PORT=4400
npm run ui:build   # build ops UI into ui/dist (served by the API)
npm start          # API + crons on :4400
```

Crons: Redis active-key refresh every 30s · metrics snapshots hourly · proposal expiry daily · nightly agent runs only if `AGENT_NIGHTLY=true`.

## Ops flow

1. **Agent tab** → run analysis for a tenant (or wait for nightly cron). Max 3 proposals/run, every hypothesis must cite tool-derived numbers, control arm mandatory.
2. **Proposals tab** → Approve & start / Approve only / Reject.
3. **Experiments tab** → per-arm funnel, Bayesian P(variant wins) on conversion and revenue/session + z-test p-value, lifecycle buttons (pause / complete / kill / promote).
4. **Promote** materializes the winning patch into tenant config (`users` **and** `semantix` core dbs — known dashboard-server inconsistency) / product `boost` fields, and busts `store-config:{apiKey}`.

The agent can also propose a **catalog filter enrichment** after inspecting real catalog coverage. These are not experiments: the proposal contains an explicit, previewable product-id set and requires human approval. Approval adds the filter to tenant credentials in both core databases, tags those catalog products, invalidates store-config caches, and records a before-state audit in `catalog_change_audits`.

## Verification

- `node --test --import tsx test/m1-verify.test.ts` — assignment parity with the dashboard-server hook, 50/50 split, traffic %, control fallback, patch composition.
- `npx tsx scripts/verify-metrics.ts` — synthetic funnel → aggregator output hand-checked (creates + drops `so_metrics_test_db`).

## Known v1 limitations

- Boost experiments affect `scoreProductLineResult` (weightedScore) only; Mongo-side `boost:-1` sort paths are untouched.
- Start/kill propagation lag ≤ ~15s (hook's in-process cache) + 30s publisher cron; "kill" is not instant.
- Exposure logs on search request, not render.
- Auto-promotion/auto-kill (M4) not yet wired: promote rule of thumb — P(conv win) > 0.95 ∧ P(rev/session win) > 0.90 ∧ min sessions/arm ∧ ≥7 days.
- Some tenants' `queries` docs lack session ids (e.g. manoVino); experiment metrics are unaffected (exposures carry the id), and the agent's funnel tool falls back to `product_clicks.search_query`.
