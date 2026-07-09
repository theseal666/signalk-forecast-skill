const createStore = require("./store.js");
const openMeteo = require("./providers/openMeteo.js");
const { circularMeanFromSums } = require("./verify.js");
const path = require("path");
const os = require("os");

const PROVIDERS = [openMeteo];
const OBS_BUCKET_MS = 10 * 60 * 1000;

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

  async function fetchAll() {
    counters.lastFetchAt = Date.now();
    for (const provider of PROVIDERS) {
      for (const model of cfg.models) {
        if (!provider.models.includes(model)) {
          app.debug(`unknown model '${model}' for provider ${provider.name} — skipped`);
          continue;
        }
        for (const loc of cfg.locations) {
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
      fetchIntervalHours: options.fetchIntervalHours || 3,
      retentionDays: options.retentionDays || 14,
      verifyWindowDays: options.verifyWindowDays || 7,
    };
    app.debug("config: " + JSON.stringify(cfg));

    store = createStore(dataDir(), app.error);
    store.prune(cfg.retentionDays);

    if (cfg.locations.length === 0) {
      app.setPluginStatus("No locations configured — add at least one in plugin settings");
      return;
    }

    const dirPaths = new Map();
    const speedPaths = new Map();
    for (const loc of cfg.locations) {
      dirPaths.set(loc.dirPath, loc.label);
      if (loc.speedPath) speedPaths.set(loc.speedPath, loc.label);
    }

    unsubscribes.push(
      app.streambundle.getSelfBus().forEach((pathValue) => {
        if (typeof pathValue.value !== "number" || isNaN(pathValue.value)) return;
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

    // First fetch shortly after startup (let the server settle), then on
    // the configured interval — models only issue new runs a few times a
    // day, so there is no point in fetching more often
    initialFetchTimer = setTimeout(fetchAll, 30 * 1000);
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
              fetchIntervalHours: cfg.fetchIntervalHours,
            }
          : null,
        counters,
        pendingBuckets: [...buckets.keys()],
      });
    });

    // M2 will serve real numbers here
    router.get("/scoreboard", (req, res) => {
      res.status(501).json({ error: "verification lands in M2 — archive is accumulating" });
    });
  };

  plugin.stop = function () {
    for (const timer of [fetchTimer, flushTimer, pruneTimer]) {
      if (timer) clearInterval(timer);
    }
    if (initialFetchTimer) clearTimeout(initialFetchTimer);
    fetchTimer = flushTimer = pruneTimer = initialFetchTimer = null;
    for (const label of [...buckets.keys()]) flushBucket(label, true);
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    store = null;
    app.debug("Plugin Forecast Skill stopped");
  };

  plugin.schema = {
    type: "object",
    properties: {
      locations: {
        type: "array",
        title: "Locations (observation truth sources)",
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
