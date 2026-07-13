# Scoring review — after ~5 days of live data (2026-07-13)

Assessment of how well the plugin rates forecasts, based on the real archive on
KarukeraPi (3,671 forecast runs, 5,305 observation records, 11 ViVa stations,
4 models, ~5 days). The verification math was re-run offline over the whole
archive with the plugin's own `verify.js`.

## Verdict

The data pipeline is solid — fetch, archive, pairing, circular stats and the
persistence baseline all work and the archive is clean. The weak part is the
**scoring/ presentation layer**, which is the actual product: two of the three
headline numbers cannot separate the models, and the one that can is hidden.

## Findings

### 1. The "Score" metric is compressed into a narrow band (design issue)

Across all 396 model×station×lead cells, Score spans only **69–91 %**
(median 81, p25–p75 = 78–85) — while the underlying `dirMAE` in those same
cells is **25–38°**. The cause is the normalisation:

```
dir_score = 1 − |err°| / 180
```

so a genuinely poor 45° error still scores 75 %, a 30° error scores 83 %, and a
coin-flip-useless 90° error still scores 50 %. Real-world performance therefore
all lands around "80 %", and the board cannot show the difference it exists to
show. **This is a formula problem, not a data problem** — deduping the archive
(below) left the distribution unchanged (66–91 %, median 81).

Recommendation: rescale the direction component to the range that actually
occurs (e.g. `1 − err°/90`, or map to a skill-relative scale), or demote Score
in favour of skill-vs-persistence as the headline. At minimum, relabel: an
"83 %" that means 30° of error is misleading.

### 2. The Composite is mathematically pinned near zero (design issue)

Every model at every station scores **1–13 %** (median 5), which reads as "all
models are useless." Decomposition at Svenska Högarna shows the ranking signal
*exists* (MET Norway recall 0.48 vs ICON 0.18) but is destroyed by the formula:

```
component = recall × precision × mean_hit
```

a product of three sub-1 numbers, then a weighted sum of several such products.
Precision is high (0.85–0.94 — models rarely cry wolf) but recall is low
(0.18–0.48) because the 10° event threshold treats normal wind noise as
"events" the model was expected to predict.

Recommendation: combine recall/precision with a harmonic mean (F1) instead of a
product; raise or smooth the event threshold so models aren't scored against
unresolvable wiggles; present relative-to-best rather than an absolute % that
always looks like an F. This matters especially because PLAN.md slates the
composite as the default landing tab (M7).

### 3. Lead-time origin was wrong: `runTime` = fetch time (correctness bug — FIXED)

`providers/openMeteo.js` stamps `runTime: Date.now()` because Open-Meteo's
forecast response carries no model init time (confirmed — only
`generationtime_ms`, which is API latency). Consequences:

- **Phantom lead times.** Open-Meteo re-serves the same model run across
  several fetches (measured: **2.9× on average, up to 7× for ECMWF**). Each
  re-serve got a new fetch-time stamp, so one forecast for a given valid time
  was scored at several different lead times.
- **Massive over-count.** The per-bucket stats did not dedup, so a single
  valid time was counted up to **~28×** in a wide bucket. `n=56,032` was really
  ~2,000 independent checks, and the error averages were heavily
  autocorrelated. The README's "trust n>10" gave false confidence.

### 4. `n` was not an independent sample count (correctness bug — FIXED)

Direct consequence of #3. See fix below.

## What was fixed in this change

All in `verify.js` (pure module, no write-path risk):

- **`attributeRunTimes()`** — detects identical re-served fetches per
  (model, location) by fingerprinting the hourly payload and rewrites each
  run's effective run time to the *first* fetch at which that content appeared.
  That first-seen time is the best available proxy for init time and the
  correct origin for lead time.
- **Valid-time dedup** — each `(bucket, valid time)` now contributes exactly one
  verification (the freshest run whose lead lands in that bucket) instead of one
  per fetch. The pre-dedup count is preserved as `nRaw` for transparency.

Before/after over the real 5-day archive:

| bucket | n (old → new) | dedup % | meanDirMAE° (old → new) | meanSkill (old → new) |
| :--- | ---: | ---: | ---: | ---: |
| 1h  | 3,119 → 1,045 | 33 % | 27.0 → 28.1 | −1.29 → −1.44 |
| 3h  | 3,079 → 994   | 32 % | 26.5 → 28.7 | 0.04 → −0.13 |
| 6h  | 9,165 → 2,665 | 29 % | 29.9 → 29.3 | 0.20 → 0.16 |
| 12h | 18,121 → 3,419 | 19 % | 31.8 → 29.1 | 0.38 → 0.37 |
| 24h | 28,280 → 3,280 | 11 % | 32.7 → 30.5 | 0.43 → 0.47 |
| 2d  | 56,560 → 2,984 | 5 % | 38.0 → 34.3 | 0.40 → 0.41 |
| 3d  | 36,964 → 1,988 | 5 % | 28.9 → 24.9 | 0.50 → 0.48 |

Sample counts are now honest; long-lead MAE improves slightly (old averages were
dragged by over-weighting the most-re-fetched stale forecasts); skill and the
composite ranking are unchanged (no regression). Unit tests in `test/`
(`node --test`) cover fingerprinting, run attribution, and dedup.

**Residual caveat (not fixed):** first-seen still lags true init by the
provider's publish latency, which differs by model (larger for ECMWF than MET
Norway). Recovering absolute init would need a provider that reports it or a
per-model schedule table. The dominant error — one run counted at many phantom
lead times — is gone; a small cross-model lead offset remains.

## Recommended next (not in this change)

1. **Rescale or replace the headline Score** (finding #1) so the board separates
   models over the 25–40° range that actually occurs.
2. **Fix the Composite aggregation** (finding #2): F1 instead of the
   recall×precision product; noise-aware event threshold; relative display.
3. **Simplify the read.** For "which model, here, today" a sailor needs three
   things: a rank, the bias correction in degrees (`dirBias` — the genuinely
   actionable number), and a confidence/sample flag. Lead with those; consider
   plain-language per model ("≈28° off, reads 12° right, beats persistence at
   12h+") over an 80-something percent.
4. **Per-model init offset** (finding #3 residual) if absolute lead-time accuracy
   across models becomes important.
