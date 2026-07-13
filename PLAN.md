# signalk-forecast-skill — Design Plan

Status: **M0–M3 + M5 done, metrics recalibrated + webapp reworked** (July 2026).
Archive, verification, distance-sorted station picker, and webapp run on
KarukeraPi.

**2026-07 recalibration + question-driven webapp (v0.6):** after ~1 week of
live data the two headline metrics couldn't separate models (Score compressed to
75–90 %; Composite pinned to 1–13 %) and forecast runs were mis-attributed /
double-counted. Fixed in `verify.js`:
- **Run attribution + dedup** — identical re-served fetches collapse to their
  first-seen run; one verification per (bucket, valid-time). `n` is now honest
  (a 2-day bucket dropped from ~56 k to ~3 k), `nRaw` kept for reference.
- **Score rescaled** `1 − err/90` (0 = random guess, 100 = perfect) → spreads
  52–86 % and separates models.
- **Composite** now `F1(recall, precision) × mean_hit` over **hourly-smoothed**
  obs with a **≥20°** shift threshold → meaningful "catches N of M shifts";
  returns `{score, recall, precision, hits, obsEvents}`.
- **Webapp** rebuilt around three sailor questions: recommendation card, best-
  match ranking with plain-language + tooltips, and best-model-by-horizon strip;
  per-lead-time metric chart moved into a collapsible Advanced panel.

Next: **M4** (SMHI/met.no adapters, SK path publishing, npm) and **M6**
(per-timeslot spaghetti chart — the intraday "switch during the race" view).
See README for current metric explanations.

## Goal

Answer one question a sailor actually asks: **"Which weather model should I
trust, here, today?"**

The plugin fetches wind forecasts from multiple models, archives them,
compares each model's predictions against real observations (ViVa weather
stations and/or the boat's own instruments) as time passes, and publishes a
running **skill scoreboard**: per model, per location, per forecast lead
time. Before a race you glance at the board and know whether ECMWF, the
high-resolution Nordic model, or GFS has been telling the truth about your
racecourse this week — and by how many degrees it usually lies.

## Non-goals

- No oscillation/shift analysis (that is signalk-windshift's job; models
  cannot resolve minute-scale oscillations anyway — they get scored on the
  mean wind and its trends: sea-breeze onset, frontal veers, gradient swings).
- No routing, no GRIB downloads, no chart display.
- Not a forecast *viewer* first — the verification is the product; showing
  forecast curves is in service of that.

## Independence (hard requirement)

100% independent of signalk-windshift. The only integration points are
SignalK conventions:

- **Inputs**: observations are read from configured SignalK paths (any path
  that carries wind direction/speed in radians / m/s). ViVa station paths
  are the expected default, but any source works — the plugin knows nothing
  about the viva plugin beyond a path string.
- **Outputs**: results published as SignalK paths + own HTTP endpoints + own
  webapp. If windshift's dashboard ever wants to overlay forecast curves, it
  consumes these endpoints like any other client. No shared code, no shared
  state, either plugin runs happily without the other.

## Architecture

```
                 ┌──────────────────────────────────────────────┐
                 │ providers/  (one adapter per source)         │
  Open-Meteo ───▶│  openMeteo.js  — many models via one API     │
  SMHI       ───▶│  smhi.js       — later                       │
  met.no     ───▶│  metno.js      — later                       │
                 └──────────────┬───────────────────────────────┘
                                │ normalized forecast runs
                                ▼
   SignalK paths      ┌──────────────────┐        ┌─────────────┐
   (ViVa stations, ──▶│    store.js      │◀──────▶│ disk (ndjson│
    boat wind)        │  obs + forecasts │        │ per day)    │
                      └────────┬─────────┘        └─────────────┘
                               │ pairs (forecast value, observed value)
                               ▼
                      ┌──────────────────┐
                      │    verify.js     │  pure functions, unit-testable
                      │  circular stats  │
                      └────────┬─────────┘
                               ▼
        SK paths  +  /plugins/forecast-skill/*  +  public/ webapp
```

### providers/ — adapter contract

Every adapter exposes:

```js
{
  name: "open-meteo",
  models: ["ecmwf_ifs025", "gfs_seamless", "icon_seamless", "metno_seamless"],
  // fetch one model's latest run for one position
  fetchRun(model, { latitude, longitude }) -> Promise<{
    model,            // string id
    runTime,          // ms epoch — when the model run was issued (or fetch time)
    position,         // { latitude, longitude }
    hours: [ { t, windDir_rad, windSpeed_ms } ]   // hourly, ~8d horizon
  }>
}
```

**Open-Meteo first** and possibly only for a long time: one keyless free
API, `&models=` parameter selects specific models, hourly
`winddirection_10m` + `windspeed_10m`. That alone yields a 4–model
comparison. SMHI open data and met.no Locationforecast come later as
separate adapters (met.no requires a descriptive User-Agent header — note
in adapter).

Fetch cadence: every 3 h per model/location (models only produce new runs
2–4× daily; re-fetching more often wastes quota). Configurable.

### store.js — the archive

Append-only ndjson, one file per day per kind, in the plugin data dir:

```
<dataDir>/forecasts/2026-07-09.ndjson   — one line per (model, location) run
<dataDir>/observations/2026-07-09.ndjson — one line per (location, 10-min bucket)
```

- Observations are subsampled before storage: a 10-minute circular mean of
  direction + mean speed per location. Verification is hourly; storing at
  Hz would be pointless bulk.
- Retention: delete files older than N days (default 14). Disk math: ~5
  models × 3 locations × 8 runs/day × ~2 KB ≈ 240 KB/day forecasts, less
  for observations — trivial.
- In-memory index of the last 14 days is rebuilt from disk on startup, so
  restarts lose nothing.

### verify.js — the math (pure functions)

Pairing: for every stored forecast hour `t` that has passed, find the
observation bucket nearest `t` (tolerance ±15 min). Each pair knows its
**lead time** = `t − runTime`.

Per (model, location, lead-time bucket), over a rolling window (default 7
days), compute:

- **score** — weighted composite of direction and speed accuracy on an
  absolute 0–1 scale: `0.7 × dir_score + 0.3 × speed_score`, where
  `dir_score = 1 − |err°| / 180` and `speed_score = 1 − |err_ms| / 5.0`.
  Always computable; used as the default metric.
- **dirMAE** — mean absolute circular error of direction (°).
- **dirBias** — mean *signed* circular error. The tactical gold: "this model
  reads 10° left of reality at this station" is directly usable on the
  water even when MAE is mediocre.
- **vectorRMSE** — RMSE of the wind vector difference (standard meteorology;
  punishes speed blunders that direction-only stats forgive).
- **speedMAE** — for completeness.
- **skill** — `1 − dirMAE(model) / dirMAE(persistence)`, where persistence
  is the baseline "forecast = observation at run time". Positive skill =
  the model beats a sailor with a wind vane and a stopwatch; negative =
  it doesn't. This keeps the scoreboard honest.

Lead-time buckets: 1 h, 2 h, 3 h, 6 h, 12 h, 24 h, 2 d, 3 d, 5 d, 7 d.
The 3–6 h bucket is the one you read at breakfast before a start;
1–3 h buckets reveal now-casting quality.

### Configuration schema (current)

```js
{
  vivaStationIds: [2113, 204, 2108],   // station numbers from viva.sjofartsverket.se/station/<n>
                                        // plugin fetches name + lat/lon automatically
  autoDiscoverViva: true,               // also picks up every station the viva plugin publishes
  locations: [                          // manual/legacy entries — still active, kept for continuity
    {
      label: "vinga",
      latitude: 57.63, longitude: 11.60,
      dirPath: "environment.observations.viva.vinga.wind.directionTrue",
      speedPath: "environment.observations.viva.vinga.wind.averageSpeed"
    }
  ],
  models: ["ecmwf_ifs025", "gfs_seamless", "metno_seamless", "icon_seamless"],
  fetchIntervalHours: 3,
  retentionDays: 14,
  verifyWindowDays: 7
}
```

### Outputs

SignalK paths (self context), per model × location — M4, not yet implemented:

```
environment.forecast.skill.<model>.<location>.dirError    (rad)
environment.forecast.skill.<model>.<location>.dirBias     (rad)
environment.forecast.skill.<model>.<location>.skill       (ratio)
```

HTTP endpoints:

- `/plugins/forecast-skill/scoreboard` — full grid: models × locations ×
  buckets with all metrics; the webapp's main course.
- `/plugins/forecast-skill/stations` — ViVa station index (name, slug, lat, lon).
- `/plugins/forecast-skill/status` — fetch/pairing counters for debugging.
- `/plugins/forecast-skill/curves?location=<id>` — planned (M6): observed
  series + each model's forecast curve for the spaghetti chart.

### public/ — webapp (current state)

Two panels, dark cockpit style:

1. **Composite panel** — one bar per model ranked by composite score (0–100 %),
   change-event accuracy over ≤ 48 h lead. Shows "not enough change events yet"
   in steady conditions.
2. **Per lead-time detail** — the per-bucket bar chart for the selected metric,
   color-coded green (good) / red (bad), absolute scale for score/composite,
   relative scale for error metrics. Sorted best-first. Composite badge always
   visible next to each model name regardless of selected metric.

Location picker is sorted nearest-to-boat when `navigation.position` is
available (Haversine, nautical miles). Distance shown as `— X nm` per entry.

Version-stamped assets (`?v=0.4.0`) — bump on every public/ change.

## Milestones

- ✅ **M0 — scaffold**: plugin skeleton, config schema, data dir, empty
  endpoints. Installable, does nothing, doesn't crash.
- ✅ **M1 — fetch & archive**: Open-Meteo adapter, scheduled fetches,
  forecasts + observations flowing to ndjson, `/status` endpoint.
- ✅ **M2 — verify**: pairing + circular stats + persistence baseline +
  scoreboard endpoint. First real answer to "which model fits".
- ✅ **M3 — webapp**: scoreboard view, per-bucket detail chart, location picker
  with distance-to-boat sort, absolute score scale, green/red color scheme.
- 🔲 **M4 — breadth**: SMHI + met.no adapters, SK path publishing, npm release.
  (Open-Meteo with 4 models, per-bucket UI, and vivaStationIds config are done.)
- ✅ **M5 — composite skill score**: single headline number per model weighting
  change-event detection, timing, and magnitude. See design note below.
- 🔲 **M6 — spaghetti chart**: per-timeslot score timeline (observed TWD bold
  + each model's curve), selectable time window, hover tooltip. The aggregate
  composite tells you the winner over 7 days; this shows the texture.
  The M6 weighted score formula (used as the default per-bucket metric) is
  already implemented; the chart itself is not.
- 🔲 **M7 — tab layout**: Score / Detail / Spaghetti tabs with URL-hash state.
  See design note below.
- 🔲 **M8 (optional)**: windshift's dashboard overlays `/curves` on its
  waterfall via HTTP — no code sharing needed.

### Design note — composite skill score (M5) — IMPLEMENTED in verify.js

The point-by-point dirMAE and persistence skill in M2 answer "how far off is
this model on average". The composite score answers "how reliable is this
model at catching what actually changes and when" — the question a sailor
asks before a race.

**Why the current metrics fall short for this question:**
A model that nails the steady-state direction but misses every frontal passage
scores low MAE and decent skill despite being nearly useless before a race.

**What 100% means:** every observed change event was predicted (recall = 1),
every predicted event happened (precision = 1), timing error = 0, direction
and speed magnitude errors = 0. Calibrated for race-morning intelligence,
not a theoretical perfect model.

**Implementation — `verify.js`:** `unwrapDir()` → `zigzagEvents()` →
`matchEvents()` → `computeComposite()`.

Thresholds:

| Variable | Event threshold | Scoring tolerance (→ score 0) |
| :--- | :--- | :--- |
| Direction | ≥ 10° swing | ± 15° magnitude |
| Wind speed | ≥ 1.5 m/s swing | ± 1.5 m/s magnitude |
| Timing (both) | — | ± 3 h (score 0 at boundary, 1 at 0 h) |

Component weights (sum to 1.0 when all data present):

| Component | Weight |
| :--- | :--- |
| Direction-event timing | 0.35 |
| Direction-event magnitude | 0.20 |
| Speed-event timing | 0.20 |
| Speed-event magnitude | 0.15 |
| Baro trend | 0.10 — reserved, not scored until pressure path is configured |

If speed or baro data is absent the weights are redistributed proportionally
across the components that did score.

Aggregate per event set:
```
component = recall × precision × mean_hit_score
```

Scope: one composite per (location, model) over all ≤ 48 h lead forecast
hours. `/scoreboard` carries a `composite` field (0–1) on each model entry.
Display as percentage (0–100 %). Per-bucket composite is future work.

### Design note — per-timeslot spaghetti score (M6)

The aggregate composite (M5) answers "which model is best this week".
The per-timeslot score answers "which model was best *at 14:00 yesterday*"
— the granularity that reveals temporal patterns: morning sea-breeze onset,
frontal passage timing, model degradation at specific lead times.

**What to show:** for each verified forecast hour `t`, the timeslot score
per model uses the same formula already implemented as the default metric:
```
timeslot_score = 0.7 × (1 − |dir_err°| / 180) + 0.3 × (1 − |speed_err_ms| / 5)
```

**Display — spaghetti-score timeline:** a time-series chart (uPlot, dark style)
with one line per model, Y axis = timeslot score 0–1.
- Each model drawn in its own color (same palette as the scoreboard)
- Observed wind overlaid as a bold reference line (secondary Y axis,
  direction in degrees) so you can see WHY a model scored low at a
  specific time — a direction error during a frontal passage
- Selectable time window (last 24h / 48h / 7d)
- Hovering a timestamp shows all models' scores + the direction errors

**Backend — new `/curves` endpoint:** return per-hour
`{ t, observed_dir, observed_speed, models: { model_id: { dir, speed, score } } }`.
The webapp builds the spaghetti chart from this; `computeScoreboard` is
unchanged (aggregate stats still come from there).

**Insight this unlocks:** if ECMWF scores 0.9 every morning and 0.4 every
afternoon, you know to trust it for the pre-start briefing but discard it
for the afternoon race. No aggregate score reveals that pattern.

### Design note — tab layout (M7)

Add a three-tab structure so the composite (the most useful single number)
is the landing view, with detail and spaghetti as secondary tabs.

```
┌─────────────────────────────────────────────────────────┐
│ Location ▾   [Score] [Detail] [Spaghetti]   7d · 10:05  │
├─────────────────────────────────────────────────────────┤
│  COMPOSITE SKILL SCORE  (default landing tab)           │
│                                                         │
│  ECMWF IFS   ██████████████████░░  73%                  │
│  MET Norway  ████████████████░░░░  65%                  │
│  GFS         ████████░░░░░░░░░░░░  44%                  │
│  ICON        ██████░░░░░░░░░░░░░░  38%                  │
└─────────────────────────────────────────────────────────┘
```

- **Score tab** (default): composite ranking only, full-height, large bars.
- **Detail tab**: per-bucket bar chart, metric dropdown, all models.
- **Spaghetti tab** (M6): per-timeslot score timeline + observed wind overlay.

Tab state in URL hash (`#score`, `#detail`, `#spaghetti`) so bookmarks and
back-button work. No routing library needed — just `hashchange` + show/hide.

### Design note — international observation sources (future)

ViVa covers Sweden well. The same observation-source pattern can be extended
to other countries' maritime weather networks via equivalent `*Locations.js`
adapters. Each needs a station index fetcher and a live-data poller; the
verification logic is unchanged. Priority list:

| Country | API | Key | Notes |
| :--- | :--- | :--- | :--- |
| Finland (FMI) | WFS opendata.fmi.fi | No | 10-min obs; XML; key stations: Utö, Hanko, Åland, Jurmo |
| Norway (Frost) | frost.met.no | Free reg | REST/JSON; Utsira, Lista, Ferder, Jomfruland |
| Denmark (DMI) | dmigw.govcloud.dk | Free reg | 10-min; GeoJSON; Skagen, Anholt, Drogden, Bornholm |
| Germany (DWD) | opendata.dwd.de | No | File-based; Arkona, Fehmarn, Warnemünde |
| Poland (IMGW) | danepubliczne.imgw.pl | No | Hourly JSON array; Hel Peninsula is the key station |
| Estonia | ilmateenistus.ee | No | XML; Osmussaar, Vilsandi, Sõrve |
| UK (Met Office) | DataPoint or DataHub | Free reg | DataPoint simplest; speed in mph (×0.44704) |

General adapter contract:
```js
{
  source: "fmi",
  fetchStations() -> Promise<Map<id, { name, latitude, longitude }>>
  fetchLatest(stationIds[], since_ms) -> Promise<[{ stationId, t, dir_rad, speed_ms }]>
}
```

## Risks & notes

- **API terms**: Open-Meteo free tier is non-commercial with fair-use
  limits (fine at our cadence); met.no requires an identifying User-Agent;
  SMHI open data is unrestricted. All keyless.
- **Model output height/exposure vs station reality**: 10 m model wind vs a
  lighthouse anemometer at 20+ m will show systematic speed bias; direction
  bias per station absorbs most of it, which is exactly why we score per
  location instead of globally.
- **Verification needs patience**: skill numbers mean little until a few
  days of pairs exist. The scoreboard shows sample counts (`n=`); do not
  act on n < 10.
- **ViVa station ID field name**: `vivaLocations.js` uses `s.ID ?? s.StationID`
  defensively. If station IDs fail to resolve, curl
  `https://services.viva.sjofartsverket.se:8080/output/vivaoutputservice.svc/vivastation/`
  and check the actual field name in the response.
- **Clock discipline**: everything in ms epoch UTC internally; the Pi runs
  NTP, forecasts come with UTC timestamps — display-local only in the webapp.
