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
# REPROCESS_SERVICE_URL=https://onboarding-lh63.onrender.com
npm run ui:build   # build ops UI into ui/dist (served by the API)
npm start          # API + crons on :4400
```

Crons: Redis active-key refresh every 30s · metrics snapshots hourly · proposal expiry daily · nightly agent runs only if `AGENT_NIGHTLY=true`.

## Daily failure workflow

Select a store in **Daily optimization**, refresh the seven-day report, and run the agent. The failure queue prioritizes zero results, low attributed engagement and cart shortfall, with explicit sample and tracking flags. Attribution requires the same normalized query, identifier and a subsequent click/cart within 30 minutes. Priority is a triage heuristic, not predicted revenue.

The agent investigates the top failures and operator notes, saves diagnoses with linked repair/proposal IDs or concrete blockers, and checks existing work before creating changes. Compact tools and paginated evidence keep issue IDs readable within the agent context. Catalog changes use exact product IDs, audited before-state checks, and selected reprocess flags. Reprocess authentication resolves `users.users.apiKey` for the selected store on each request; there is no shared reprocess API key. Scoped classification requires onboarding capabilities v3 and preserves unrelated soft categories.

The store's daily policy enables reports and optional agent analysis once per 24 hours (hourly scheduler checks). Manual and scheduled agent runs share a store lock and existing budget limits. Automatic catalog execution is a separate store policy; ranking experiments retain their review flow. Redis/cache or reprocess verification failures remain visible as unfinished work.

Verified repairs get a seven-day follow-up against an equally long pre-change window. Missing identifiers, tracking gaps or fewer than 30 identifiers per window prevent an improvement conclusion. Before/after cart rates are observational, not proof of purchase conversion, revenue or causal uplift; controlled experiments remain necessary. A catalog-verified action does not prove live search ranking is correct.

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
- Some tenants' `queries` docs lack session ids (e.g. manoVino). Daily funnel rates exclude unidentified searches from the identifier denominator and show missing coverage; they never substitute click-selected identifiers as the denominator. Purchase/revenue claims require their own valid tracking.

### Hebrew search-leakage reviews

Agent reviews and generated operator explanations are requested in Hebrew, with an in-depth evidence-based diagnosis of search leakage, explicit saved actions, verification criteria and a next-review handoff. The Optimization screen displays the latest completed review followed by links to its investigations and repairs, above the existing execution queue. Experiment proposals remain in Proposals.

Full reviews are retained in `agent_runs.summary`. Each new run receives the three latest completed reviews for the store (with a legacy API-key fallback), and records `previousReviewIds` for traceability. The agent must recheck historical claims, revisit open commitments and distinguish prepared actions, execution, catalog verification and measured search improvement. Failed-run partial text is retained but is not treated as a completed review. Existing historical reviews are not retroactively translated.
