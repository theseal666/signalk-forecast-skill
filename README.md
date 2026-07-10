# signalk-forecast-skill

A SignalK plugin that fetches wind forecasts from multiple weather models,
verifies them against real observations (ViVa weather stations, or any
SignalK wind source), and keeps a running **skill scoreboard** — which model
fits reality best, per location and forecast lead time.

Built for pre-race preparation: in the days before a start, the plugin
quietly collects each model's predictions and scores them as the weather
actually happens. By race morning you know whether to plan around ECMWF,
the high-resolution Nordic model, or neither — and whether your trusted
model habitually reads a few degrees left or right at your racecourse.

**Status: M3 + M5 live** — verification, composite skill score, and webapp
running on KarukeraPi since July 2026. See [PLAN.md](PLAN.md) for architecture
and roadmap.

Fully independent of (but a good neighbor to)
[signalk-windshift](https://github.com/theseal666/signalk-windshift) and
[signalk-viva](https://github.com/theseal666/signalk-viva-plugin):
integration is via SignalK paths and HTTP only.

## The idea in one picture

```
forecasts (many models) ──┐
                          ├──▶ archive ──▶ compare as time passes ──▶ scoreboard
observations (stations) ──┘                                           + bias per model
```

A model only earns *skill* by beating **persistence** ("the wind stays as it
is now") — the honest baseline that separates real forecasting from noise.

## How it works

1. **Fetch** — every 3 h the plugin downloads the latest 8-day hourly wind
   forecast from [Open-Meteo](https://open-meteo.com) (free, no API key).
   Models: ECMWF IFS 0.25°, NOAA GFS, DWD ICON, MET Norway Nordic.

2. **Archive** — forecast runs and 10-minute circular-mean observations are
   written to append-only ndjson files in the plugin data directory
   (`forecasts/YYYY-MM-DD.ndjson`, `observations/YYYY-MM-DD.ndjson`).
   Retention is 14 days by default.

3. **Pair & score** — as time passes, each forecast hour is matched to the
   nearest observation (±15 min) and scored on every metric (see below).
   Pairs are grouped into **lead-time buckets**: 1 h / 2 h / 3 h / 6 h /
   12 h / 24 h / 2 d / 3 d / 5 d / 7 d.

4. **Display** — built-in webapp at `/plugins/forecast-skill/` shows:
   - **Composite panel** — one bar per model, ranked 0–100 %.
   - **Per lead-time detail** — color-coded bars, green = good, red = bad.
   - **Location picker** — sorted nearest-to-boat when GPS is available,
     with distance in nautical miles.

## Metrics reference

Every verified forecast hour contributes one (forecast, observation) pair.
Metrics are computed over all pairs inside the selected rolling window (default 7 days).

### Quick reference

| Metric | Unit | Range | Better = | Scale in webapp |
| :--- | :---: | :--- | :--- | :--- |
| **Score** | % | 0–100 | Higher | Absolute 0–100 %, green=high |
| **dirMAE** | ° | ≥ 0 | Lower | Relative (worst = full bar) |
| **dirBias** | ° | −180 to +180 | Closer to 0 | Relative |
| **speedMAE** | m/s | ≥ 0 | Lower | Relative |
| **vectorRMSE** | m/s | ≥ 0 | Lower | Relative |
| **Skill** | — | −∞ to 1 | Higher | Relative |
| **Composite** | % | 0–100 | Higher | Absolute 0–100 %, green=high |

---

### Score (default metric) — 0 to 100 %

The primary metric. A weighted combination of direction accuracy and speed accuracy, on a fixed 0–100 % absolute scale.

```
score = 0.7 × dir_score + 0.3 × speed_score

dir_score   = max(0,  1 − |direction_error°| / 180 )
speed_score = max(0,  1 − |speed_error m/s| / 5.0  )
```

The direction component saturates to 0 at 180° error; the speed component saturates at 5 m/s error. Neither can go negative.

**How to read it:**

| Score | What it means |
| :--- | :--- |
| 90–100 % | Excellent — roughly ≤ 18° direction error and ≤ 0.5 m/s speed error |
| 75–90 %  | Good — reliable tactical input |
| 60–75 %  | Fair — usable with caution; check dirBias for a correction value |
| < 60 %   | Poor — do not rely on this model at this lead time |

The 70 / 30 weight reflects sailing priorities: being off by 20° on a layline costs more than being off by 1 m/s on speed. The 5 m/s speed scale is intentionally forgiving — a 5 m/s miss is a full Beaufort step error; normal forecast spread is well within that.

Because the scale is absolute, you can compare scores across locations and lead times directly: an 82 % at 24 h lead means the same thing at Vinga and at Svenska Högarna.

---

### Direction MAE (dirMAE) — degrees

Mean absolute circular error of wind direction.

```
dirMAE = mean( circular_distance(forecast_dir, observed_dir) )
```

"Circular distance" handles the 360°/0° wraparound correctly: the error between 355° and 005° is 10°, not 350°. Internally everything is computed in radians and converted to degrees for display.

**What the number means:**

| dirMAE | What it means |
| :--- | :--- |
| < 10° | Very good — well within tactical noise |
| 10–20° | Acceptable for planning; worth noting the bias |
| 20–35° | Marginal — check dirBias and decide whether to correct |
| > 35° | Unreliable at this lead time or station |

---

### Direction Bias (dirBias) — signed degrees

Mean *signed* circular error. Positive = model reads clockwise (right) of reality on average.

```
dirBias = circular_mean( forecast_dir − observed_dir )
```

**This is the most directly usable number for racing.** If ECMWF consistently reads +12° at Vinga, you know its NW forecast really means NNW. Apply this correction to tomorrow's forecast before drawing laylines.

**Examples:**

- `+15°` at a station → the model forecasts SW but reality is SSW; your port tack layline is further than the model suggests
- `−8°` → the model reads left of reality; starboard tack is favored more than it appears
- Near zero with high MAE → errors are random (no consistent bias); the model is generally poor at this station, not just biased

A large dirBias combined with a decent Score means the model is *consistent* but wrong in a predictable direction — a correctable error, much better than random scatter.

---

### Speed MAE (speedMAE) — m/s

Mean absolute error of wind speed (scalar, not vector).

```
speedMAE = mean( |forecast_speed_ms − observed_speed_ms| )
```

Typical values: 0.5–1.5 m/s is good for a coastal station. Values above 2 m/s at a sheltered fjord station are expected due to topographic channelling that models can't resolve. Convert to knots: 1 m/s ≈ 1.94 kt.

---

### Vector RMSE (vectorRMSE) — m/s

Root mean square error of the full wind vector. Punishes direction *and* speed errors together.

```
U = speed × sin(direction),  V = speed × cos(direction)  (east/north components)

vectorRMSE = sqrt( mean( (U_forecast − U_obs)² + (V_forecast − V_obs)² ) )
```

A direction error alone creates a vector error even if speeds match: at 10 m/s true wind, a 30° direction error is equivalent to about 5 m/s vector error. This metric is standard in meteorological verification and catches models that look OK on speed but consistently miss direction.

vectorRMSE is always ≥ speedMAE. The gap between them reflects direction error contribution.

---

### Skill vs persistence — dimensionless

Compares the model against the simplest possible forecast: *"assume the wind at the finish of the forecast run never changes."*

```
skill = 1 − dirMAE(model) / dirMAE(persistence)

persistence_error(pair) = circular_distance( observed_dir_at_run_time, observed_dir_at_t )
```

| Skill | What it means |
| :--- | :--- |
| 1.0 | Perfect (zero direction error) |
| 0.5 | Cuts direction error in half compared to "wind stays constant" |
| 0.0 | Same as persistence — the model adds no value |
| −0.5 | 50 % *worse* than just assuming nothing changes |
| Very negative | Common and expected at short lead times — see note below |

**Why negative skill at 1–3 h is normal:** at very short lead times the wind simply hasn't had time to change much since the forecast was issued. Persistence ("it was 240° so it'll stay 240°") is nearly perfect. The model's interpolated hourly value fluctuates slightly around that, introducing errors that persistence avoids. This is not a model failure — it is a fundamental property of short-range forecasting. Negative skill at 1–3 h means nothing about race-day usefulness; look at skill at 12–48 h to judge whether a model genuinely adds predictive value.

---

### Composite score — 0 to 100 %

A single headline number per model that focuses on *change events* rather than average accuracy. A model that nails steady-state wind but misses every frontal passage scores low composite despite good dirMAE — and that model is nearly useless before a race.

**How it works:**

The algorithm detects wind-shift events in the observation record (zigzag analysis: ≥ 10° direction swing or ≥ 1.5 m/s speed swing within a sliding window). For each observed event, it asks: did the model predict it? How close in timing? How accurate in magnitude?

| Event property | Threshold | Scoring scale |
| :--- | :--- | :--- |
| Direction swing threshold | ≥ 10° | — |
| Speed swing threshold | ≥ 1.5 m/s | — |
| Timing error | — | 0 = ±3 h off, 1 = exact |
| Direction magnitude error | — | 0 = ±15° off, 1 = exact |
| Speed magnitude error | — | 0 = ±1.5 m/s off, 1 = exact |

Component weights:

| Component | Weight |
| :--- | :--- |
| Direction-event timing | 35 % |
| Direction-event magnitude | 20 % |
| Speed-event timing | 20 % |
| Speed-event magnitude | 15 % |
| Baro trend | 10 % (reserved — not scored until pressure path is configured) |

Each component score = `recall × precision × mean_hit_quality`. The composite is the weighted sum over all components with data.

Only ≤ 48 h lead-time forecast hours are used (event prediction beyond 48 h is speculative).

**What to watch:** the composite needs a few days of actual wind-shift events to produce meaningful numbers. In steady high-pressure conditions it will show "not enough change events yet". That is correct — when nothing changes, there is nothing to score event detection against.

---

## Installation

```bash
cd ~/.signalk
npm install https://github.com/theseal666/signalk-forecast-skill.git
sudo systemctl restart signalk
```

Enable and configure the plugin in the SignalK admin UI under
**Server → Plugin Config → Forecast Skill**.

## Configuration

| Setting | Default | Description |
| :--- | :--- | :--- |
| ViVa station numbers | — | Enter station numbers from viva.sjofartsverket.se/station/\<id\>. Plugin fetches name and coordinates automatically. |
| Auto-discover ViVa | on | Picks up every station the signalk-viva plugin publishes. Additive — does not replace station numbers. |
| Manual locations | — | Advanced: explicit label, lat/lon, and SignalK paths. For boat instruments or non-ViVa sources. |
| Models | 4 Open-Meteo models | ECMWF IFS 0.25°, GFS, ICON, MET Norway Nordic |
| Fetch interval | 3 h | How often to re-download forecasts |
| Retention | 14 days | How long to keep archived files |
| Verification window | 7 days | Rolling window for the scoreboard |

## HTTP endpoints

Served under `/plugins/forecast-skill/`.

| Endpoint | Description |
| :--- | :--- |
| `/scoreboard` | Full verification grid: models × locations × buckets + composites. Cached 5 min. |
| `/stations` | Full ViVa station index (slug, name, lat, lon). |
| `/status` | Plugin counters and pending observation buckets. |

## Tips for reading the results

**Sample count is the first thing to check.** The webapp shows `n=` next to
every bar. `n < 10` pairs is not enough to trust any metric. Give it 2–3
days per lead-time bucket. The 1 h bucket fills fastest; the 7 d bucket
needs a full week.

**Score vs skill measure different things.** Score is absolute accuracy
(75 % = roughly 27° off and 1.5 m/s off). Skill compares against the
persistence baseline. A model can score 80 % but still have negative skill
at 1–3 h lead time — that is normal and expected (see the Skill section
above). Use skill to judge whether a model adds value over "nothing changes";
use Score and dirBias for concrete correction values.

**dirBias is the most directly actionable number for racing.** If a model
consistently reads +12° right of reality at your racecourse, subtract 12°
from its forecast before the start.

**Fjord stations** (Stenungsund, Uddevalla, etc.) show large errors and biases
at short lead times. This is not a model failure — it is topographic
channelling that no 10 km grid model can resolve. Use open-sea stations
(Vinga, Svenska Högarna, Landsort) as your primary reference and fjord
stations only as local wind pressure indicators.

**Multiple stations near the racecourse** tell different stories. Compare
the bias sign across stations: if all models read +10–15° right at Svenska
Högarna and near-zero at Vinga, that is a local Kattegat coastal jet effect
— plan your strategy around it, not around the model's raw number.

## What's next

- **M4** — SMHI and met.no Locationforecast adapters, SignalK path publishing, npm release
- **M6** — per-timeslot spaghetti chart: observed TWD with each model's forecast curve overlaid
- **M7** — tab layout: Score / Detail / Spaghetti with URL-hash state
