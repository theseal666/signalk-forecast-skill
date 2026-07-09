# signalk-forecast-skill — Design Plan

Status: **M2+M3 live** (July 2026). Archive, verification, scoreboard
endpoint and webapp are running. M4 (SMHI/met.no adapters, SK path
publishing, npm release) is next. See README for current state.

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
  models: ["ecmwf_ifs025", "gfs_seamless", "icon_seamless", "metno_seamless", "knmi_harmonie_arome_europe"],
  // fetch one model's latest run for one position
  fetchRun(model, { latitude, longitude }) -> Promise<{
    model,            // string id
    runTime,          // ms epoch — when the model run was issued (or fetch time)
    position,         // { latitude, longitude }
    hours: [ { t, windDir_rad, windSpeed_ms } ]   // hourly, ~48h horizon
  }>
}
```

**Open-Meteo first** and possibly only for a long time: one keyless free
API, `&models=` parameter selects specific models, hourly
`winddirection_10m` + `windspeed_10m`. That alone yields a 4–5 model
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

- **dirMAE** — mean absolute circular error of direction (the headline
  number, in degrees).
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

Lead-time buckets: 0–6 h, 6–12 h, 12–24 h, 24–48 h. The 6–12 h bucket is
the one you read at breakfast before a start.

### Outputs

SignalK paths (self context), per model × location:

```
environment.forecast.skill.<model>.<location>.dirError    (rad)
environment.forecast.skill.<model>.<location>.dirBias     (rad)
environment.forecast.skill.<model>.<location>.skill       (ratio)
```

HTTP endpoints (same style as windshift's):

- `/plugins/forecast-skill/scoreboard` — full grid: models × locations ×
  buckets with all metrics; the webapp's main course.
- `/plugins/forecast-skill/curves?location=<id>` — recent observed series +
  each model's forecast curve past and future, for the spaghetti chart.
- `/plugins/forecast-skill/status` — fetch/pairing counters for debugging.

### public/ — webapp

Two views, same dark cockpit style as windshift's dashboard:

1. **Scoreboard** — table of models × locations, colored by skill (green =
   beats persistence comfortably, red = worse than persistence), bias shown
   as `+8°`/`−5°` arrows, selectable lead-time bucket.
2. **Spaghetti chart** — observed TWD (bold) with each model's curve
   overlaid in its own color, extending into the future. Where the lines
   have been hugging the bold one is this week's winner; where they diverge
   tomorrow is the risk.

Version-stamped assets from day one (lesson learned in windshift).

## Configuration schema (sketch)

```js
{
  locations: [            // observation truth sources
    {
      label: "vinga",
      latitude: 57.63, longitude: 11.60,
      dirPath: "environment.observations.viva.vinga.wind.directionTrue",
      speedPath: "environment.observations.viva.vinga.wind.averageSpeed"
    },
    // boat: dirPath environment.wind.directionTrue + live position
  ],
  models: ["ecmwf_ifs025", "gfs_seamless", "metno_seamless", "icon_seamless"],
  fetchIntervalHours: 3,
  retentionDays: 14,
  verifyWindowDays: 7
}
```

Possible later sugar: an "auto-follow ViVa stations" toggle that watches
`environment.observations.viva.*` and fills `locations` automatically (still
just path-convention coupling, no code dependency).

## Milestones

- **M0 — scaffold**: plugin skeleton, config schema, data dir, empty
  endpoints. Installable, does nothing, doesn't crash.
- **M1 — fetch & archive**: Open-Meteo adapter, scheduled fetches,
  forecasts + observations flowing to ndjson, `/status` endpoint. Run for
  a couple of days to accumulate material.
- **M2 — verify**: pairing + circular stats + persistence baseline +
  scoreboard endpoint. First real answer to "which model fits".
- **M3 — webapp**: scoreboard view, then spaghetti chart.
- **M4 — breadth**: SMHI + met.no adapters, per-bucket UI, SK path
  publishing, npm release.
- **M5 — composite skill score (0–100 %)**: a single headline number per
  model that weights all data with emphasis on *detecting changes correctly
  and on time*. See the design note below.
- **M6 (optional, still decoupled)**: windshift's dashboard overlays
  `/curves` output on its waterfall via HTTP — no code sharing.

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
|---|---|---|
| Direction | ≥ 10° swing | ± 15° magnitude |
| Wind speed | ≥ 1.5 m/s swing | ± 1.5 m/s magnitude |
| Timing (both) | — | ± 3 h (score 0 at boundary, 1 at 0 h) |

Component weights (sum to 1.0 when all data present):

| Component | Weight |
|---|---|
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
hours. `/scoreboard` gains a `composite` field (0–1) on each model entry.
Display as percentage (0–100 %). Per-bucket composite is future work.

### Design note — station picker UI (M4 / configuration)

Goal: before a race weekend, the user picks which ViVa stations to score
against, without editing JSON config. Different races need different stations
— Vinga for Gothenburg races, Landsort/Björn for Stockholm, etc.

**Proposed UX:**
- A `/plugins/forecast-skill/stations` endpoint returns the full ViVa station
  index (name, slug, lat, lon) fetched from the ViVa API (already cached in
  `vivaLocations.js`). Response shape:
  ```json
  [{ "slug": "vinga", "name": "Vinga", "latitude": 57.63, "longitude": 11.60 }, ...]
  ```
- The webapp config panel shows a searchable dropdown/list of all ViVa
  stations. The user picks ≤ N stations and hits Save.
- Save POSTs to `/plugins/forecast-skill/config/locations`, which calls
  `app.savePluginOptions()` (the same mechanism the admin UI uses), so the
  selection survives restarts without touching files manually.
- Lat/lon come from the ViVa index — the user never types coordinates.
- The boat can also appear in the list (uses `environment.wind.directionTrue`
  + live GPS position) as a special entry "Boat (GPS)".

**Config schema change:** `locations` stays as-is server-side (array of
`{label, latitude, longitude, dirPath, speedPath}`). The station-picker UI
just builds these objects from the ViVa index and POSTs them — no schema
migration needed.

### Design note — additional forecast model providers (future)

Open-Meteo is keyless and covers 4–5 models well. Additional providers
will be added as separate adapters in `providers/`:

- **SMHI open data** — Swedish high-resolution model, keyless, good for
  Swedish coastal waters, hourly 10 m wind. Requires descriptive User-Agent.
- **met.no Locationforecast 2.0** — Norwegian met office, keyless, good
  Nordic model. Requires identifying User-Agent header per their ToS.
- **Paid/private models** — any provider that returns JSON with hourly
  `(direction_deg, speed_ms)` can be wrapped in a one-file adapter. The
  adapter contract is minimal (see Architecture section above). API keys go
  in plugin config as `providers[].apiKey`, stored in SignalK plugin-config
  and never committed.

The scoreboard and composite logic are model-agnostic — adding a provider
just means it shows up as new rows in the scoreboard table.

## Risks & notes

- **API terms**: Open-Meteo free tier is non-commercial with fair-use
  limits (fine at our cadence); met.no requires an identifying User-Agent;
  SMHI open data is unrestricted. All keyless.
- **Model output height/exposure vs station reality**: 10 m model wind vs a
  lighthouse anemometer at 20+ m will show systematic speed bias; direction
  bias per station absorbs most of it, which is exactly why we score per
  location instead of globally.
- **Verification needs patience**: skill numbers mean little until a few
  days of pairs exist. The scoreboard should show sample counts and refuse
  to color-code below a minimum n.
- **Clock discipline**: everything in ms epoch UTC internally; the Pi runs
  NTP, forecasts come with UTC timestamps — display-local only in the webapp.
```
