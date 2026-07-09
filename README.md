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

**Status: planning.** See [PLAN.md](PLAN.md) for the full design —
architecture, provider adapters, verification math, storage layout,
endpoints and milestones.

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
