# Large-Document Translation Architecture

**Status:** Phase A is **implemented and shipped** (§5.1). Phases B → D are design
only. Nothing in any phase makes a provider switch or a local LLM load-bearing —
chunking, queueing, retrying and key scheduling are the mechanism.
**Scope:** how a large document is split, budgeted, scheduled, retried and re-merged.
**Non-goals:** switching provider/model as a *solution* to size, or requiring a local LLM. Those remain optional *user choices*, never the mechanism that makes a large file work.

---

## 1. What exists today (and what is actually broken)

The pipeline is already structurally sound. These parts are **not** the problem and should be kept:

| Layer | Where | Why it is good |
|---|---|---|
| Durable queue | `core/jobQueue.ts` + `translate/translateQueue.ts:319-333` | Snapshot persisted to `translate.run.<projectId>` after **every** settled batch. |
| Idempotent resume | `translateQueue.ts:928-960` (`restoreTranslate`) | Re-plans from **Dexie block state**, not the snapshot. `classifyBlock` (158-165) drops `translated`/`edited`, so re-running never re-translates. Restart-safe by construction. |
| Per-block merge | `translateQueue.ts:484-545` (`persistLines`) | Writes `block.translatedText` per block. The block row *is* the merged document — there is no separate document-merge step that can lose or duplicate content. |
| Response validation | `translate/batchValidation.ts:129-177` | Count → shape → **order-independent FNV-1a checksum** → exact id set → non-empty. Output is rebuilt in *input* order; model output order is never trusted. |
| Retry ladder | `translate/engine.ts:181-248` | full batch → halve → per-line → single-line repair → keep source at `confidence 0.2` / `kept-original`. Never loses a line. |
| Key pool | `translate/keyPool.ts` | rpm/tpm/rpd sliding buckets, `Retry-After` honoured, exponential backoff ±25% jitter, quota → 1 h, invalid keys removed, live headers override estimates, state persisted + rehydrated on restart. |
| Multi-key rotation | `translate/executor.ts:151-273` | Rotates on 429/5xx/timeout, advances the model chain on 404, waits when all keys cool, gives up after 30 consecutive failures. |
| Concurrency | `translate/concurrency.ts` | AIMD 1↔3 with per-page mutex — already adapts to error rate. |

The problem is **not** "we cannot process a large document". The problem is that **the size of each request is guessed, not computed**, and the guess is wrong in a way that compounds.

> **Status:** root causes **A** (§1.1) and **B** (§1.2) are fixed as of Phase A (§5.1). Root cause **C** (§1.3) is half fixed — the budget is now model-derived and hard, but the chunker is still line-based and structure-blind (Phase B).

### 1.1 Root cause A — the token estimate is script-blind

`estimateTokens` (`keyPool.ts:129-131`) is `max(1, ceil(text.length / 3))`. That ratio is tuned for English. Every downstream calculation inherits it:

- `batching.ts:45,77` — batch size budget (`maxTokens: 1500`);
- `engine.ts:153,276` — the **TPM bucket** the key pool consumes;
- `prompts.ts:185-188` — `maxOutputTokensFor = min(4000, tokens × 1.6)`.

For Myanmar script (and CJK/Devanagari) BPE vocabularies are sparse, so a character carries far more than ⅓ token. If the real factor is 3–6× the estimate, a "1500-token" batch is in truth 4500–9000 tokens. Consequences:

1. **The TPM bucket under-counts**, so the pool happily admits 3 concurrent batches that are really 18–27K tokens in flight → against Groq free's **8K TPM** this is a permanent 429 loop.
2. **`maxOutputTokensFor` under-provisions**, so long Burmese lines get truncated mid-JSON → validation fails on `not-json`/`count` → the ladder splits → *more* requests → quota burns faster. A death spiral that looks like "the model cannot handle my document".
3. The **context window is never consulted at all**. `ModelSpec.contextWindow` (`models.config.ts:29`) is display metadata; no code path feeds it into `buildBatches`, `runBatch` or the prompt builder.

> This is the single highest-value fix. A document that "does not fit" is very often a document whose *estimate* was wrong, not whose model was too small.

### 1.2 Root cause B — daily-quota 429s are misclassified as bursts

`providers/http.ts:64-67`:

```ts
function looksLikeQuota(text: string, status: number): boolean {
  if (status === 429) return false          // ← quota can never be detected
  return /quota|resource_exhausted|daily limit|insufficient_quota|…/i.test(text)
}
```

Providers return **429** for both burst throttling and daily-quota exhaustion. Because the guard short-circuits on `429`, `statusToKind` (73) always yields `rate_limit`, never `quota`. So:

- `executor.ts:197-204` calls `reportRateLimit({quota:false})` → cooldown **2 s → 5 min**, not the `quotaFallbackMs` 1 h;
- the worker maps `rate_limit` → `ALL_KEYS_COOLING_DOWN` instead of `QUOTA_EXHAUSTED` (`protocol.ts:153-162`);
- a document that needs 1 400 requests on a 1 000-req/day tier **does not stop cleanly** — it retries against a wall 30 times and fails with a misleading reason.

The body text is already parsed; the guard simply must not exclude 429.

### 1.3 Root cause C — request sizing is model-blind and structurally naive

`batching.ts` accumulates lines into 15–25-line batches with a flat `maxTokens: 1500`.
Phase A replaced the flat constant with the model's real budget and made it a
*hard* budget; the rest of this list is still open:

- `minLines: 15` was a **floor consulted before the token budget**, so a page of long lines could push a batch far past budget — **fixed in Phase A** (§5.1);
- a single oversized line is never split (no per-line path in `buildBatches`) — **open, Phase B**;
- `BlockKind` (`heading | paragraph | list | table | caption | shape`, `db/types.ts:88`) is **never consulted** — a table is split at an arbitrary line boundary and a heading can be stranded at the end of a batch — **open, Phase B**;
- only **one** neighbour line is passed as context (`translateQueue.ts:258-264`, `prompts.ts:141-146`), which is thin for consistency over hundreds of pages — **open, Phase C**.

### 1.4 The second direction of the size problem

The 1500-token target is simultaneously **too large** (§1.1) and **far too small** for big-context models. On a model with a 128K window, filling only 1.5K tokens of content per request wastes >98% of the window and multiplies request count — and **requests**, not tokens, are what the free tier rationing kills (Groq: 1 000 req/day). A 1 000-page document at 25 lines/batch can exceed the daily request budget purely because batches were timid.

**Conclusion:** the fix is to *compute* the batch from the model's real budget, so one request carries as much content as is safe. That reduces request count, which is the scarce resource — without switching provider.

---

## 2. Architecture

Seven layers. Each is independently testable; none requires a provider switch.

```
 ┌──────────────────────────────────────────────────────────────┐
 │ 1  BudgetProfile      model + quality + glossary → real limits│
 │ 2  TokenEstimator     script-aware + self-calibrating         │
 │ 3  StructureChunker   headings/tables/lists + oversized split │
 │ 4  Pacing & Quota     request forecast, quota scope, ETA      │
 │ 5  KeyScheduler       multi-key = optional throughput         │
 │ 6  ContextContinuity  heading chain + TM + terminology sets   │
 │ 7  Integrity          exactly-once verification at the end    │
 └──────────────────────────────────────────────────────────────┘
```

### Layer 1 — `BudgetProfile` (new file `src/translate/budget.ts`)

The single source of truth for "how much may go into one request". Computed **once per run** from `(provider, model, quality, glossarySize)` and stored in the run config so restarts reuse identical boundaries.

```ts
export interface BudgetProfile {
  contextWindow: number        // hard window (input + output)
  maxOutputTokens: number      // model's real completion cap
  promptOverheadTokens: number // system prompt + glossary + framing, measured
  contentBudgetTokens: number  // contextWindow − overhead − maxOutput
  fillTargetTokens: number     // ceil(contentBudget × FILL_RATIO)
  maxLines: number             // secondary guard
  unknown: boolean             // true when the model is unlisted/imported
}

export const FILL_RATIO = 0.85          // headroom for tokenizer drift + framing
export const UNKNOWN_CONTEXT_WINDOW = 8_192   // conservative default
export const UNKNOWN_MAX_OUTPUT     = 2_048
```

Sources and rules:

- `contextWindow` ← `modelSpec(provider, model)?.contextWindow`, else the conservative default. Note `modelSpec` is bundled-only by design (`models.config.ts:525-529`), so imported models correctly fall back to the conservative window.
- `maxOutputTokens` ← new optional `ModelSpec.maxOutput`; default `min(contextWindow / 2, 4_096)` when absent. Today nothing stores this, and it is the value that actually truncates Burmese output.
- `promptOverheadTokens` ← **measure the real prompt**, not guess: `estimateTokens(systemPrompt(...)) + estimateTokens(glossaryBlock(...)) + framing`. `glossaryBlock` is capped at 200 entries (`prompts.ts:83`), which can be ~200 lines — material, and today unmeasured anywhere.
- `contentBudgetTokens = max(1024, contextWindow − promptOverheadTokens − maxOutputTokens)`.
- High quality doubles content volume (`reviewPrompt`, `prompts.ts:159-178` re-sends source **and** draft) → the review pass must be budgeted as a **second request** against the same window, not ignored.

Wiring: `buildTranslatePlan` computes the profile and passes it to `buildBatches`; `engine.ts` uses `profile.maxOutputTokens` instead of `maxOutputTokensFor`'s flat formula; `preflight.ts:129-137` stops using its own `chars / 3.5` estimate and uses the same profile so the forecast matches reality.

### Layer 2 — script-aware, self-calibrating token estimation

Replace the flat `len / 3` with a **weighted estimator** (`src/translate/tokenEstimate.ts`), keeping the exact export name so the ~10 call sites stay valid:

```ts
// Per-script character→token weights, measured against real responses.
const SCRIPT_WEIGHT = { latin: 0.30, myanmar: 1.10, cjk: 0.70, devanagari: 0.90, cyrillic: 0.35, digits: 0.40 }
export function estimateTokens(text: string): number   // weighted sum, max(1, …)
```

Plus a **runtime calibration loop**, which is what makes this correct rather than merely less wrong:

- every response already returns `usage.prompt_tokens` / `completion_tokens` (`keyPool.reportSuccess`, `translateQueue.ts:701`);
- the run keeps `calibration = { predictedIn, actualIn, predictedOut, actualOut }`;
- after each successful batch, `scale = clamp(actualIn / predictedIn, 0.5, 4.0)` is folded in (EWMA, α ≈ 0.3) and stored on the run;
- `estimateTokens` for the remainder of the run is multiplied by that scale.

This is self-correcting within a handful of requests regardless of language, so it also covers unknown/imported models and future tokenizer changes. Two safety properties:

- **never scale down below the static weight** (a bad early sample can't inflate batches);
- if the observed ratio stays pinned at the clamp for 3 consecutive batches, the run flags `LOW_TOKEN_CONFIDENCE` and shrinks `fillTargetTokens` by 25% rather than continuing to overshoot.

### Layer 3 — structure-aware chunker (rewrite of `batching.ts` internals, same public API)

`buildBatches(projectId, epoch, pageIndex, lines, { budget, policy })` keeps its signature-compatible entry point and its **order-preservation invariant** (already pinned by `batching.test.ts:31-34,49-51`), but groups *before* it packs:

1. **Reconstruct logical units** from consecutive lines by `BlockKind`:
   - a run of `table` lines → one **TableUnit** (never split at a row boundary; if it alone exceeds `contentBudget`, split at *row groups* and repeat the header row as context);
   - `heading` → **binds forward** to the next non-skipped unit (a heading is never the last item in a batch);
   - `caption` → binds backward to its preceding figure/table;
   - `list` → splits only **between items**, never mid-item;
   - `paragraph` / `shape` → indivisible unless oversized (below).
2. **Pack units** by measured tokens toward `fillTargetTokens`, never past `contentBudgetTokens`, with `maxLines` as a secondary guard. The `minLines` floor that used to let an oversized batch through is already gone (Phase A); what is left here is the packing *order* — units, not raw lines.
3. **Oversized single unit** (one paragraph wider than the budget) → sentence-boundary split with ids `` `${batchId}#s${n}` ``, reassembled by the existing `splitToLines` id convention so validation and the merge path are unchanged. A unit that is *one* sentence longer than the budget is the one true irreducible case (§5).
4. **Context enrichment**: each batch now carries `{ before, after }` as today, **plus** the nearest enclosing heading and its translation (`sectionDigest`), which costs ~10 tokens and buys most of the consistency that a larger neighbour window would.

The retry ladder, `splitBatch`/`splitToLines` and `#cache`/`#l<n>` id conventions are untouched — `batchValidation` and `resume.test.ts` continue to hold.

### Layer 4 — pacing and honest quota forecasting

Requests, not tokens, are the scarce resource on free tiers. Before the run starts, `preflight` computes and **shows**:

```
requests   = ceil(totalContentTokens / fillTargetTokens)
tokens     = totalContentTokens × (1 + outputRatio)
wallTime   = requests / effectiveRpm   (with TPM as the binding constraint)
fitsToday  = requests ≤ rpd && tokens ≤ tpd
```

- If it does not fit today, the app says so **in numbers** and states the honest outcome: the queue is durable, so the run pauses on quota and **resumes across days** — that already works (`restoreTranslate` + `QUOTA_EXHAUSTED`). This is a correct answer, not a workaround.
- **Shipped in Phase A** (§5.1): `looksLikeQuota` consults the body text for 429 too, so `QUOTA_EXHAUSTED` is actually reported. `providers/http.test.ts` pins the Gemini (`RESOURCE_EXHAUSTED`), OpenAI (`insufficient_quota`) and Groq bodies.
- Add a **daily request ledger** per `(provider, model)` in settings so the forecast is compared against *observed* consumption, not just the bundled `rpd`.

### Layer 5 — key scheduling: multi-key is optional, never required

Existing behaviour already satisfies the requirement for per-key quotas: a single key works, `pick()` filters by capacity, rotation happens on 429. What is missing is **quota scope**:

```ts
// models.config.ts ModelSpec / ProviderMeta
quotaScope?: 'per-key' | 'per-provider'   // default 'per-key'
```

- `per-key` (most providers, and OpenAI-compatible custom endpoints): each key owns its own rpm/tpm/rpd buckets — additive. Current behaviour, correct.
- `per-provider` (Groq free tier is org-scoped; Gemini AI Studio is project-scoped): the pool keeps **one shared bucket per provider** across all its keys, so adding a second key improves *throughput* (more rpm in parallel) but does **not** multiply the daily allowance.

This directly encodes "do not assume more keys = more quota". Selection preference order stays: capacity-fit → `least-used`/round-robin → earliest-available. Nothing in the design requires a second key: with one key the pool is a degenerate case of the same algorithm, and `startTranslate` continues to accept exactly one.

### Layer 6 — context continuity across chunks

Long documents lose coherence when each request sees only 25 lines. Cheap mitigations, in priority order:

1. **Heading chain** (Layer 3.4) — the nearest heading + its translation, always included. Highest value per token.
2. **TM reuse** — already present (`lookupTranslation` at `translateQueue.ts:568-599` writes via `storeTranslation`), so repeated terms stay consistent across chunks and restarts. Keep.
3. **Terminology sets** — `seenPage`/`seenDocument` already flow into every request (`translateQueue.ts:692-699`). Keep; ensure they are also seeded on restore so a resumed run doesn't forget document-wide terms learned before the restart.
4. **Rolling glossary** — promote high-frequency TM hits into the injected glossary for the remainder of the run (still capped at `glossaryBlock`'s 200 entries).

### Layer 7 — merge integrity verification

The merge is already exactly-once per block (per-block writes + id-set validation + re-plan-from-state). Add an explicit end-of-run check so "missing or duplicated" is *verified*, not assumed:

```ts
verifyDocumentIntegrity(projectId): { ok, missing: BlockId[], duplicated: BlockId[] }
```

run after the queue reaches `done`, surfaced through the existing `CoverageReport`. Any `missing` id is automatically re-queued on the next run because it is still `pending` in Dexie — the invariant is already self-healing; this just makes it visible.

---

## 3. What chunking genuinely cannot fix

Stated plainly, per the brief:

1. **A single sentence larger than the model's context window.** No chunker splits it. The fallback is a flagged keep-original (`kept-original`, confidence 0.2) — already the engine's terminal behaviour — surfaced in coverage. Rare, and honest.
2. **A document whose total token count exceeds the provider's *daily token* allowance.** Chunking cannot make 5 M tokens fit a 200 K/day tier in one day. The correct behaviour is: forecast it up front (Layer 4), pause on `QUOTA_EXHAUSTED`, and resume across days on the durable queue. If the user wants it done in one sitting, that is a paid-tier decision — a *user* choice, not the mechanism.
3. **Cross-document anaphora** (a pronoun whose antecedent is 200 pages back). Bounded context means bounded recall. The heading chain and document glossary recover most of it; the residual is a quality limit inherent to chunked translation, not a scheduling defect.

---

## 4. Design invariants (to be pinned by tests)

1. **Order**: flattened batch line ids, in order, equal the input block ids, in order. *(already pinned)*
2. **Exactly-once**: after any sequence of start → fail → restore → resume, every block id is produced exactly once and every block ends `translated`/`edited`/`skipped`. *(already pinned)*
3. **Budget safety**: for every emitted batch, `estimateTokens(system) + estimateTokens(user) + maxOutputTokens ≤ contextWindow`. *(new)*
4. **Structure atomicity**: no table is split between rows; no heading terminates a batch; lists split only between items. *(new)*
5. **Calibration monotonicity**: the calibration scale is clamped to `[0.6, 4]`, and may not fall below 1 until five samples agree — one noisy response can shrink batches only upward. *(pinned by `tokenEstimate.test.ts`)*
6. **Single-key sufficiency**: every scenario in the test suite must pass with exactly one API key. *(new assertion on existing tests)*
7. **Non-additive quota**: with `quotaScope: 'per-provider'`, N keys never admit more tokens/day than one key. *(new)*

---

## 5. Implementation phases

Each phase is independently shippable, gated by `tsc · eslint · prettier · vitest · build · smoke`.

| Phase | Deliverable | Primary files | Why first |
|---|---|---|---|
| **A ✅ shipped** | `BudgetProfile` + script-aware estimator + calibration + the 429-quota classification fix | `translate/budget.ts`, `translate/tokenEstimate.ts`, `translate/batching.ts`, `providers/http.ts`, `translate/engine.ts`, `translate/translateQueue.ts`, `workers/translation.worker.ts` | Fixes the root cause. Largest accuracy gain, smallest blast radius. |
| **B** | Structure-aware chunker (logical units, oversized split, heading binding) | `translate/batching.ts`, `translate/types.ts` | Turns correct budgets into *well-formed* requests. |
| **C** | Context continuity (heading chain, rolling glossary, terminology reseeding on restore) | `translate/prompts.ts`, `translate/translateQueue.ts`, `translate/tm.ts` | Quality at scale, cheap. |
| **D** | Quota scope, daily ledger, forecast UI (and the `preflight` alignment), integrity verification | `config/models.config.ts`, `translate/keyPool.ts`, `pdf/preflight.ts`, `translate/coverage.ts` | Makes multi-key honest and large runs observable. |

### 5.1 Phase A — what shipped

**New: `translate/tokenEstimate.ts`.** Script-aware `estimateTokens`. ASCII keeps
the exact `ceil(count / 3)` arithmetic, so Latin documents produce byte-identical
batches to before; Myanmar is charged 1.10 a character, Thai 0.95, Devanagari
0.90, Arabic 0.75, CJK/Hangul 0.70, combining marks 0.50. Alongside it,
`recordTokenCalibration(predicted, actual)` is an EWMA on a scale factor driven by
the `usage.prompt_tokens` every provider already returns — clamped to `[0.6, 4]`,
and forbidden from shrinking below 1 until five samples agree, because shrinking
is the direction that makes batches *bigger*.

**New: `translate/budget.ts`.** `computeBudget({ provider, models, quality, … })`
→ `BudgetProfile`. The **narrowest window in the fallback chain** wins, so a batch
sized for the selected model also fits whatever fallback answers.
`promptOverheadTokens` is *measured* from the real `systemPrompt(...)`, which
already embeds up to 200 glossary lines; High quality divides the content budget
by 2.05 because its review pass re-sends source **and** draft.

**Wired through:**

- `buildTranslatePlan` passes `maxTokens = profile.fillTargetTokens` to
  `buildBatches`, and the `minLines` gate that let a page of long lines overshoot
  the budget is gone — `maxTokens` is now a hard budget. `BATCH_DEFAULTS` loses
  `minLines`. Batching for Latin documents is unchanged.
- `engine.ts` takes an optional `budget` and uses `maxOutputFor(profile, batch)` —
  a completion cap proportional to what is actually being sent, clamped by the
  model — instead of the flat `min(4000, tokens × 1.6)` that was truncating long
  Burmese lines mid-JSON. With `calibrate: true` it folds each response's usage
  back into the estimator; `translation.worker.ts` turns that on and resets the
  scale per session.
- `providers/http.ts` — `looksLikeQuota` no longer returns `false` for 429.
  Daily / `per day` / `insufficient_quota` bodies are now `quota` (1 h cooldown →
  `QUOTA_EXHAUSTED`); `per minute` / `try again in …` bodies stay `rate_limit`.
  This is what lets a document that needs more requests than the day's allowance
  stop cleanly and resume, instead of retrying against a wall thirty times.

**Deferred from the original Phase A list: `pdf/preflight.ts`.** Its
`estimateTranslationWork` is handed a bare character count, so a script-aware
estimate needs text it does not have; aligning the forecast with the budget
belongs with the forecast UI in Phase D.

**Explicitly out of scope as a "solution":** auto-switching OpenRouter→Groq, and
Local AI. Both stay available as user-selectable options; neither is load-bearing
for large files.
