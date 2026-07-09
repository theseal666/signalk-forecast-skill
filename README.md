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

**Status: M2+M3 — verification and webapp running.** See [PLAN.md](PLAN.md)
for the full architecture, verification math, and milestone roadmap.

Fully independent of (but a good neighbor to)
[signalk-windshift](https://github.com/theseal666/signalk-windshift) and
[signalk-viva](https://github.com/theseal666/signalk-viva-plugin):
integration is via SignalK paths and HTTP only.

## The idea in one picture

```
forecasts (many models) ──┐
                          ├──▶ archive ──▶ compare as time passes ──▶ scoreboard
observations (stations) ──┘                                           + bias per model
                                                                      + spaghetti chart
```

A model only earns *skill* by beating **persistence** ("the wind stays as it
is now") — the honest baseline that separates real forecasting from noise.

## How it works

1. **Fetch** — every 3 h the plugin downloads the latest 8-day hourly wind
   forecast for each configured location from [Open-Meteo](https://open-meteo.com)
   (free, no API key). Models: ECMWF IFS 0.25°, NOAA GFS, DWD ICON, MET Norway Nordic,
   and optionally KNMI Harmonie AROME.

2. **Archive** — forecast runs and 10-minute circular-mean observations are
   written to append-only ndjson files in the plugin data directory
   (`forecasts/YYYY-MM-DD.ndjson`, `observations/YYYY-MM-DD.ndjson`).
   Retention is 14 days by default.

3. **Pair & score** — as time passes, each forecast hour is matched to the
   nearest observation (±15 min tolerance). Per (model, location, lead-time bucket):
   - **dirMAE** — mean absolute circular direction error (°)
   - **dirBias** — mean *signed* error; positive = model reads right of reality
   - **speedMAE** — mean absolute speed error (m/s)
   - **vectorRMSE** — RMSE of the full wind vector (m/s)
   - **skill** — `1 − dirMAE(model) / dirMAE(persistence)`. Positive = beats
     "the wind stays as it was when the forecast was issued"; negative = doesn't.

4. **Display** — built-in webapp shows the scoreboard per location and
   lead-time bucket (6 h / 12 h / 24 h / 2 d / 3 d / 5 d / 7 d) as color-coded
   bar charts, with a location and metric dropdown.

## Installation

```bash
cd ~/.signalk
npm install https://github.com/theseal666/signalk-forecast-skill.git
sudo systemctl restart signalk
```

Enable and configure the plugin in the SignalK admin UI under
**Server → Plugin Config → Forecast Skill**.

## Accessing the webapp

```
http://<your-signalk-ip>/signalk-forecast-skill/
```

The scoreboard shows "no verified pairs yet" for the first day or two while
the archive fills — that is expected.

## Configuration

| Setting | Default | Description |
| :--- | :--- | :--- |
| Auto-discover ViVa stations | on | Coordinates fetched from ViVa API for every station the viva plugin publishes |
| Manual locations | — | Optional additional sources (label, lat/lon, SignalK dir/speed paths) |
| Models | 4 Open-Meteo models | Which weather model IDs to fetch |
| Fetch interval | 3 h | How often to re-download forecasts |
| Retention | 14 days | How long to keep archived files |
| Verification window | 7 days | Rolling window for the scoreboard |

With [signalk-viva](https://github.com/theseal666/signalk-viva-plugin)
installed and auto-discovery on, no manual location configuration is needed —
the plugin discovers every ViVa station the viva plugin follows and looks up
their coordinates from the ViVa API automatically.

## HTTP endpoints

Served under `/plugins/forecast-skill/`, require an active SignalK session.

| Endpoint | Description |
| :--- | :--- |
| `/scoreboard` | Full verification grid: models × locations × lead-time buckets. Cached 5 min. |
| `/status` | Plugin config, fetch counters, pending observation buckets. |

## Notes on interpretation

- **Sample count matters**: scores with `n < ~5` are statistically meaningless.
  The webapp shows `n=` next to every bar.
- **Lead time is from fetch time**: Open-Meteo does not expose the model
  initialization timestamp, so lead times are measured from when the plugin
  fetched the run. Short-range buckets include some "now-casting" skill.
- **Exposure mismatch**: models predict 10 m wind; station anemometers sit at
  lighthouse heights (20–40 m). Expect systematic speed bias per station.
  The **dirBias** metric is the most directly usable on the water.

## What's next (M4)

- SMHI open data and met.no Locationforecast adapters for additional model coverage
- Spaghetti chart: observed TWD overlaid with each model's forecast curve
- SignalK path publishing of per-model skill scores
- npm release
