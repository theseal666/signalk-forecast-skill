// Open-Meteo adapter — one keyless API, many weather models selectable via
// the `models` parameter. Free tier is non-commercial fair use; our cadence
// (a handful of calls every few hours) is far below any limit.

const MODELS = {
  ecmwf_ifs025: "ECMWF IFS 0.25°",
  gfs_seamless: "NOAA GFS",
  icon_seamless: "DWD ICON",
  metno_seamless: "MET Norway Nordic",
  knmi_harmonie_arome_europe: "KNMI Harmonie AROME",
};

const DEFAULT_MODELS = [
  "ecmwf_ifs025",
  "gfs_seamless",
  "icon_seamless",
  "metno_seamless",
];

async function fetchRun(model, position) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", position.latitude);
  url.searchParams.set("longitude", position.longitude);
  url.searchParams.set("hourly", "wind_speed_10m,wind_direction_10m");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("timeformat", "unixtime"); // UTC epoch, no timezone games
  url.searchParams.set("forecast_days", "3");
  url.searchParams.set("models", model);

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from open-meteo for ${model}`);
  const json = await res.json();
  const h = json.hourly;
  if (!h || !Array.isArray(h.time)) throw new Error(`no hourly data for ${model}`);

  const hours = [];
  for (let i = 0; i < h.time.length; i++) {
    if (h.wind_direction_10m[i] == null || h.wind_speed_10m[i] == null) continue;
    hours.push({
      t: h.time[i] * 1000,
      dir: (h.wind_direction_10m[i] * Math.PI) / 180,
      speed: h.wind_speed_10m[i],
    });
  }

  return {
    provider: "open-meteo",
    model,
    // Open-Meteo doesn't expose the model init time in this response, so
    // lead times are measured from fetch time — documented in PLAN.md
    runTime: Date.now(),
    position: { latitude: position.latitude, longitude: position.longitude },
    hours,
  };
}

module.exports = {
  name: "open-meteo",
  models: Object.keys(MODELS),
  modelLabels: MODELS,
  defaultModels: DEFAULT_MODELS,
  fetchRun,
};
