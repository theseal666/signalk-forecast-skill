const createStore = require("./store.js");
const openMeteo = require("./providers/openMeteo.js");
const { circularMeanFromSums, computeScoreboard } = require("./verify.js");
const { fetchStationIndex } = require("./vivaLocations.js");
const path = require("path");
const os = require("os");

const PROVIDERS = [openMeteo];
const OBS_BUCKET_MS = 10 * 60 * 1000;
const SCOREBOARD_CACHE_MS = 5 * 60 * 1000;
const VIVA_DIR_RE = /^environment\.observations\.viva\.([^.]+)\.wind\.directionTrue$/;

module.exports = function (app) {
  const plugin = {};

  plugin.id = "forecast-skill";
  plugin.name = "Forecast Skill";
  plugin.description =
    "Scores weather forecast models against observed wind (ViVa stations or boat instruments)";

  let unsubscribes = [];
  let store = null;
  let cfg = null;
  let fetchTimer = null;
  let initialFetchTimer = null;
  let flushTimer = null;
  let pruneTimer = null;
  let stationIndexTimer = null;

  let dirPaths = new Map();
  let speedPaths = new Map();
  let knownSlugs = new Set();
  let stationIndex = null; // slug -> { latitude, longitude, name } from ViVa
  let scoreboardCache = null;
  let boatPosition = null; // latest navigation.position from SignalK

  // per-location observation aggregation into 10-minute circular means
  let buckets = new Map(); // label -> { start, sumSin, sumCos, nDir, sumSpeed, nSpeed }

  let counters = {
    forecastRuns: 0,
    fetchErrors: 0,
    obsRecords: 0,
    lastFetchAt: null,
    lastError: null,
  };

  function dataDir() {
    return typeof app.getDataDirPath === "function"
      ? app.getDataDirPath()
      : path.join(os.homedir(), ".signalk", "forecast-skill");
  }

  function updateStatus() {
    if (!cfg) return;
    app.setPluginStatus(
      `${cfg.models.length} models × ${cfg.locations.length} locations — ` +
        `${counters.forecastRuns} runs archived, ${counters.obsRecords} obs points` +
        (counters.fetchErrors ? `, ${counters.fetchErrors} fetch errors` : "")
    );
  }

  function flushBucket(label, force) {
    const b = buckets.get(label);
    if (!b || b.nDir === 0) return;
    if (!force && Date.now() - b.start < OBS_BUCKET_MS) return;
    store.append("observations", {
      t: b.start + Math.round(OBS_BUCKET_MS / 2),
      location: label,
      dir: circularMeanFromSums(b.sumSin, b.sumCos),
      speed: b.nSpeed > 0 ? b.sumSpeed / b.nSpeed : null,
      n: b.nDir,
    });
    counters.obsRecords++;
    buckets.delete(label);
    updateStatus();
  }

  function addObservation(label, kind, value) {
    let b = buckets.get(label);
    if (b && Date.now() - b.start >= OBS_BUCKET_MS) {
      flushBucket(label, true);
      b = null;
    }
    if (!b) {
      b = { start: Date.now(), sumSin: 0, sumCos: 0, nDir: 0, sumSpeed: 0, nSpeed: 0 };
      buckets.set(label, b);
    }
    if (kind === "dir") {
      b.sumSin += Math.sin(value);
      b.sumCos += Math.cos(value);
      b.nDir++;
    } else {
      b.sumSpeed += value;
      b.nSpeed++;
    }
  }

  function addLocation(loc) {
    cfg.locations.push(loc);
    dirPaths.set(loc.dirPath, loc.label);
    if (loc.speedPath) speedPaths.set(loc.speedPath, loc.label);
    app.debug(
      `auto-discovered location '${loc.label}' at ${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}`
    );
    updateStatus();
  }

  async function refreshStationIndex() {
    try {
      stationIndex = await fetchStationIndex();
      app.debug(`ViVa station index loaded: ${stationIndex.size} slugs`);
    } catch (e) {
      app.debug("ViVa station index fetch failed: " + e.message);
    }
  }

  async function fetchAll() {
    counters.lastFetchAt = Date.now();
    for (const provider of PROVIDERS) {
      for (const model of cfg.models) {
        if (!provider.models.includes(model)) {
          app.debug(`unknown model '${model}' for provider ${provider.name} — skipped`);
          continue;
        }
        for (const loc of [...cfg.locations]) {
          try {
            const run = await provider.fetchRun(model, loc);
            run.location = loc.label;
            store.append("forecasts", run);
            counters.forecastRuns++;
          } catch (e) {
            counters.fetchErrors++;
            counters.lastError = `${model}@${loc.label}: ${e.message}`;
            app.debug(`fetch failed for ${model} at ${loc.label}: ${e.message}`);
          }
          // be polite to the API
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    }
    updateStatus();
    app.debug(
      `fetch cycle done — ${counters.forecastRuns} runs archived total, ${counters.fetchErrors} errors`
    );
  }

  plugin.start = function (options) {
    app.debug("Plugin Forecast Skill started");

    cfg = {
      locations: (options.locations || []).filter(
        (l) =>
          l &&
          l.label &&
          typeof l.latitude === "number" &&
          typeof l.longitude === "number" &&
          l.dirPath
      ),
      models:
        options.models && options.models.length
          ? options.models
          : openMeteo.defaultModels,
      autoDiscoverViva: options.autoDiscoverViva !== false,
      fetchIntervalHours: options.fetchIntervalHours || 3,
      retentionDays: options.retentionDays || 14,
      verifyWindowDays: options.verifyWindowDays || 7,
    };
    app.debug("config: " + JSON.stringify(cfg));

    store = createStore(dataDir(), app.error);
    store.prune(cfg.retentionDays);

    dirPaths = new Map();
    speedPaths = new Map();
    knownSlugs = new Set();
    for (const loc of cfg.locations) {
      dirPaths.set(loc.dirPath, loc.label);
      if (loc.speedPath) speedPaths.set(loc.speedPath, loc.label);
      knownSlugs.add(loc.label);
    }

    if (cfg.autoDiscoverViva) {
      refreshStationIndex();
      stationIndexTimer = setInterval(refreshStationIndex, 24 * 3600 * 1000);
    } else if (cfg.locations.length === 0) {
      app.setPluginStatus("No locations configured and auto-discovery is off");
      return;
    }

    unsubscribes.push(
      app.streambundle.getSelfBus().forEach((pathValue) => {
        if (
          pathValue.path === "navigation.position" &&
          pathValue.value &&
          typeof pathValue.value.latitude === "number" &&
          typeof pathValue.value.longitude === "number"
        ) {
          boatPosition = { lat: pathValue.value.latitude, lon: pathValue.value.longitude };
          return;
        }
        if (typeof pathValue.value !== "number" || isNaN(pathValue.value)) return;

        // Locations appear by themselves: any ViVa station the viva plugin
        // starts publishing gets coordinates from the station index
        if (cfg.autoDiscoverViva && stationIndex) {
          const m = VIVA_DIR_RE.exec(pathValue.path);
          if (m && !knownSlugs.has(m[1])) {
            const slug = m[1];
            knownSlugs.add(slug); // only look each slug up once
            const st = stationIndex.get(slug);
            if (st) {
              addLocation({
                label: slug,
                latitude: st.latitude,
                longitude: st.longitude,
                dirPath: `environment.observations.viva.${slug}.wind.directionTrue`,
                speedPath: `environment.observations.viva.${slug}.wind.averageSpeed`,
              });
            }
          }
        }

        const dirLoc = dirPaths.get(pathValue.path);
        if (dirLoc) addObservation(dirLoc, "dir", pathValue.value);
        const speedLoc = speedPaths.get(pathValue.path);
        if (speedLoc) addObservation(speedLoc, "speed", pathValue.value);
      })
    );

    // Flush buckets whose window has passed even if a source goes quiet
    flushTimer = setInterval(() => {
      for (const label of [...buckets.keys()]) flushBucket(label, false);
    }, 60 * 1000);

    pruneTimer = setInterval(() => store.prune(cfg.retentionDays), 24 * 3600 * 1000);

    // First fetch shortly after startup (let the server and auto-discovery
    // settle), then on the configured interval — models only issue new runs
    // a few times a day
    initialFetchTimer = setTimeout(fetchAll, 60 * 1000);
    fetchTimer = setInterval(fetchAll, cfg.fetchIntervalHours * 3600 * 1000);

    updateStatus();
  };

  plugin.registerWithRouter = function (router) {
    // Fetch/pairing counters for debugging without log access
    router.get("/status", (req, res) => {
      res.json({
        config: cfg
          ? {
              locations: cfg.locations.map((l) => l.label),
              models: cfg.models,
              autoDiscoverViva: cfg.autoDiscoverViva,
              fetchIntervalHours: cfg.fetchIntervalHours,
            }
          : null,
        counters,
        pendingBuckets: [...buckets.keys()],
      });
    });

    // Full ViVa station index — used by the webapp station picker UI.
    // Returns [{slug, name, latitude, longitude}] sorted by name.
    router.get("/stations", (req, res) => {
      if (!stationIndex) {
        return res.status(503).json({ error: "station index not yet loaded" });
      }
      const list = [];
      for (const [slug, st] of stationIndex) {
        list.push({ slug, name: st.name || slug, latitude: st.latitude, longitude: st.longitude });
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      res.json(list);
    });

    // The verification result: models × locations × lead-time buckets
    router.get("/scoreboard", (req, res) => {
      if (!store || !cfg) return res.status(503).json({ error: "plugin not started" });
      const now = Date.now();
      if (scoreboardCache && now - scoreboardCache.generatedAt < SCOREBOARD_CACHE_MS) {
        return res.json(scoreboardCache);
      }
      // forecasts issued up to 8 days before the window can still have
      // valid hours inside it
      const forecasts = store.readSince(
        "forecasts",
        now - (cfg.verifyWindowDays + 8) * 86400000
      );
      const observations = store.readSince(
        "observations",
        now - cfg.verifyWindowDays * 86400000 - 3600000
      );
      const sb = computeScoreboard({
        forecasts,
        observations,
        now,
        windowDays: cfg.verifyWindowDays,
      });
      // attach coordinates for the webapp
      const byLabel = new Map(cfg.locations.map((l) => [l.label, l]));
      for (const loc of sb.locations) {
        const known = byLabel.get(loc.label);
        if (known) {
          loc.latitude = known.latitude;
          loc.longitude = known.longitude;
        }
      }
      sb.modelLabels = openMeteo.modelLabels;
      sb.boatPosition = boatPosition;
      scoreboardCache = sb;
      res.json(sb);
    });
  };

  plugin.stop = function () {
    for (const timer of [fetchTimer, flushTimer, pruneTimer, stationIndexTimer]) {
      if (timer) clearInterval(timer);
    }
    if (initialFetchTimer) clearTimeout(initialFetchTimer);
    fetchTimer = flushTimer = pruneTimer = stationIndexTimer = initialFetchTimer = null;
    for (const label of [...buckets.keys()]) flushBucket(label, true);
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    store = null;
    scoreboardCache = null;
    app.debug("Plugin Forecast Skill stopped");
  };

  plugin.schema = {
    type: "object",
    properties: {
      autoDiscoverViva: {
        type: "boolean",
        title:
          "Auto-discover ViVa stations (coordinates fetched from the ViVa API for every station the viva plugin publishes)",
        default: true,
      },
      locations: {
        type: "array",
        title: "Manual locations (optional when auto-discovery is on)",
        items: {
          type: "object",
          required: ["label", "latitude", "longitude", "dirPath"],
          properties: {
            label: { type: "string", title: "Label (short, e.g. station slug)" },
            latitude: { type: "number", title: "Latitude" },
            longitude: { type: "number", title: "Longitude" },
            dirPath: {
              type: "string",
              title: "SignalK path for observed wind direction (rad)",
            },
            speedPath: {
              type: "string",
              title: "SignalK path for observed wind speed (m/s, optional)",
            },
          },
        },
      },
      models: {
        type: "array",
        title: "Weather models (Open-Meteo model ids)",
        default: openMeteo.defaultModels,
        items: { type: "string" },
      },
      fetchIntervalHours: {
        type: "number",
        title: "Forecast fetch interval (hours)",
        default: 3,
      },
      retentionDays: {
        type: "number",
        title: "Archive retention (days)",
        default: 14,
      },
      verifyWindowDays: {
        type: "number",
        title: "Verification window (days)",
        default: 7,
      },
    },
  };

  return plugin;
};
