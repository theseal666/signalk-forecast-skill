// Pure math for circular quantities and forecast verification.
// No I/O in this module — everything here is unit-testable in isolation.

function normalize(diff) {
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff;
}

function normalize2pi(angle) {
  return ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

function circularMeanFromSums(sumSin, sumCos) {
  return normalize2pi(Math.atan2(sumSin, sumCos));
}

// Lead-time buckets: a pair lands in the first bucket whose upper bound
// (hours between model run and valid time) it fits under
const BUCKETS = [
  { id: "1h", maxHours: 1 },
  { id: "2h", maxHours: 2 },
  { id: "3h", maxHours: 3 },
  { id: "6h", maxHours: 6 },
  { id: "12h", maxHours: 12 },
  { id: "24h", maxHours: 24 },
  { id: "2d", maxHours: 48 },
  { id: "3d", maxHours: 72 },
  { id: "5d", maxHours: 120 },
  { id: "7d", maxHours: 168 },
];

function bucketIndexForLead(leadMs) {
  const h = leadMs / 3600000;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (h <= BUCKETS[i].maxHours) return i;
  }
  return -1;
}

// Binary search for the observation nearest to t (arr sorted by t)
function nearestObs(obsSorted, t, tolMs) {
  let lo = 0;
  let hi = obsSorted.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const o = obsSorted[mid];
    if (best === null || Math.abs(o.t - t) < Math.abs(best.t - t)) best = o;
    if (o.t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  return best && Math.abs(best.t - t) <= tolMs ? best : null;
}

// --- Composite skill score helpers ---

// Unwrap a direction series to avoid zigzag artifacts at the 0/2π boundary.
// pts: [{t, v}] sorted by t, v in radians.
function unwrapDir(pts) {
  if (!pts.length) return [];
  const out = [{ t: pts[0].t, v: pts[0].v }];
  for (let i = 1; i < pts.length; i++) {
    let diff = pts[i].v - pts[i - 1].v;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    out.push({ t: pts[i].t, v: out[i - 1].v + diff });
  }
  return out;
}

// Detect inflection points where the series reverses by >= threshold.
// Returns [{t, v}] at confirmed extrema (peaks and troughs).
function zigzagEvents(pts, threshold) {
  if (pts.length < 3) return [];
  const events = [];
  let extreme = pts[0];
  let trend = 0; // 0 = not yet established, +1 = rising, -1 = falling
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const d = p.v - extreme.v;
    if (trend === 0) {
      if (d >= threshold) { trend = 1; extreme = p; }
      else if (d <= -threshold) { trend = -1; extreme = p; }
    } else if (trend === 1) {
      if (p.v >= extreme.v) {
        extreme = p;
      } else if (extreme.v - p.v >= threshold) {
        events.push(extreme); extreme = p; trend = -1;
      }
    } else {
      if (p.v <= extreme.v) {
        extreme = p;
      } else if (p.v - extreme.v >= threshold) {
        events.push(extreme); extreme = p; trend = 1;
      }
    }
  }
  return events;
}

// Collapse a point series into hourly bins (circular-mean direction, mean
// speed) so change-event detection sees tactically real shifts, not the
// minute-scale sensor noise a weather model can never resolve. Forecasts are
// already hourly; smoothing the observations puts both on the same footing.
// pts: [{t, dir (rad), speed?}] sorted by t  ->  [{t, dir, speed}] sorted by t
function smoothHourly(pts) {
  const bins = new Map();
  for (const p of pts) {
    const h = Math.floor(p.t / 3600000) * 3600000;
    if (!bins.has(h)) bins.set(h, { t: h, sumSin: 0, sumCos: 0, sumSpeed: 0, nSpeed: 0 });
    const b = bins.get(h);
    b.sumSin += Math.sin(p.dir);
    b.sumCos += Math.cos(p.dir);
    if (typeof p.speed === "number") { b.sumSpeed += p.speed; b.nSpeed++; }
  }
  return [...bins.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => ({
      t: b.t,
      dir: Math.atan2(b.sumSin, b.sumCos),
      speed: b.nSpeed > 0 ? b.sumSpeed / b.nSpeed : null,
    }));
}

// Match each observed event to the nearest forecast event within toleranceMs
// (greedy, shortest-distance-first). Returns { hits, misses, falseAlarms }.
function matchEvents(obsEvents, fcstEvents, toleranceMs) {
  const usedFcst = new Set();
  const hits = [];
  const misses = [];
  for (const obs of obsEvents) {
    let bestIdx = -1;
    let bestDt = Infinity;
    for (let i = 0; i < fcstEvents.length; i++) {
      if (usedFcst.has(i)) continue;
      const dt = Math.abs(fcstEvents[i].t - obs.t);
      if (dt <= toleranceMs && dt < bestDt) { bestDt = dt; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      hits.push({ obs, fcst: fcstEvents[bestIdx] });
      usedFcst.add(bestIdx);
    } else {
      misses.push(obs);
    }
  }
  const falseAlarms = fcstEvents.filter((_, i) => !usedFcst.has(i));
  return { hits, misses, falseAlarms };
}

// Per-bucket score normalisation scale for wind speed (M6).
// A |speed_error| of this many m/s maps to score = 0; smaller errors score higher.
// 5 m/s ≈ 10 kts — a large but plausible error in coastal sailing conditions.
const SCORE_SPEED_SCALE_MS = 5.0;

// Composite score constants — calibrated for racing use.
// Tolerances define "perfect": a hit within ±3h timing and ±15° direction
// scores 1.0 on those components. At the tolerance boundary the score is 0.
const COMPOSITE_DIR_THRESHOLD_RAD = (20 * Math.PI) / 180; // ≥20° swing confirms a tactically real dir shift
const COMPOSITE_SPD_THRESHOLD_MS = 2.0;                   // ≥2.0 m/s swing confirms spd event
const COMPOSITE_TIMING_TOL_MS = 3 * 3600 * 1000;          // ±3h matching window + timing score
const COMPOSITE_DIR_TOL_DEG = 15;                         // ±15° magnitude tolerance
const COMPOSITE_SPD_TOL_MS = 1.5;                         // ±1.5 m/s magnitude tolerance
const COMPOSITE_MIN_OBS_EVENTS = 2;                       // refuse to score with < 2 observed events
const COMPOSITE_MAX_LEAD_MS = 48 * 3600 * 1000;           // only score forecasts ≤ 48h lead

// Composite score for one (location, model) pair over the verification window.
//
// "How reliably does this model catch the wind shifts that actually happen,
// at the right time and size?" Per quality dimension the component is
//   component = F1(recall, precision) × mean_hit_quality
// where F1 is the harmonic mean of recall and precision. F1 penalises both
// missed shifts and false alarms, but — unlike the old recall×precision
// product — does not collapse toward zero, so scores spread across 0–1 and
// rank models meaningfully.
//
// Component weights (renormalised over whatever data is present):
//   0.35 — direction-event timing
//   0.20 — direction-event magnitude
//   0.20 — speed-event timing
//   0.15 — speed-event magnitude
//
// Returns an object:
//   { score, recall, precision, hits, obsEvents }
// where recall/hits/obsEvents describe the DIRECTION shifts (used for the
// plain-language "catches N of M shifts" summary). score is null when there
// are not enough observed events to judge.
//
// obsPts: [{t, dir (rad), speed? (m/s)}] sorted by t
// fcstPts: [{t, dir (rad), speed? (m/s)}] — ≤48h lead, deduped by valid time (latest run wins)
function computeComposite(obsPts, fcstPts) {
  const NONE = { score: null, recall: null, precision: null, hits: 0, obsEvents: 0 };
  if (obsPts.length < 5 || fcstPts.length < 5) return NONE;

  // Smooth observations to hourly so we score real shifts, not sensor noise.
  const obsPtsH = smoothHourly(obsPts);

  const obsDir = unwrapDir(obsPtsH.map((p) => ({ t: p.t, v: p.dir })));
  const fcstDir = unwrapDir(fcstPts.map((p) => ({ t: p.t, v: p.dir })));
  const obsEvents = zigzagEvents(obsDir, COMPOSITE_DIR_THRESHOLD_RAD);
  const fcstEvents = zigzagEvents(fcstDir, COMPOSITE_DIR_THRESHOLD_RAD);

  const obsSpd = obsPtsH.filter((p) => p.speed != null).map((p) => ({ t: p.t, v: p.speed }));
  const fcstSpd = fcstPts.filter((p) => p.speed != null).map((p) => ({ t: p.t, v: p.speed }));
  const obsSpdEvents = zigzagEvents(obsSpd, COMPOSITE_SPD_THRESHOLD_MS);
  const fcstSpdEvents = zigzagEvents(fcstSpd, COMPOSITE_SPD_THRESHOLD_MS);

  const hasDirEvents = obsEvents.length >= COMPOSITE_MIN_OBS_EVENTS;
  const hasSpdEvents = obsSpdEvents.length >= COMPOSITE_MIN_OBS_EVENTS;
  if (!hasDirEvents && !hasSpdEvents) return NONE;

  let totalWeight = 0;
  let totalScore = 0;

  // One component: weight × F1(recall, precision) × mean-hit-score.
  function applyComponent(recall, precision, hits, weight, scoreFn) {
    const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
    const meanHit =
      hits.length > 0 ? hits.reduce((s, h) => s + scoreFn(h), 0) / hits.length : 0;
    totalScore += weight * f1 * meanHit;
    totalWeight += weight;
  }

  let dirRecall = null;
  let dirPrecision = null;
  let dirHits = 0;
  let dirObs = 0;

  if (hasDirEvents) {
    const { hits, misses, falseAlarms } = matchEvents(
      obsEvents,
      fcstEvents,
      COMPOSITE_TIMING_TOL_MS
    );
    const nObs = hits.length + misses.length;
    const nFcst = hits.length + falseAlarms.length;
    const recall = nObs > 0 ? hits.length / nObs : 0;
    const precision = nFcst > 0 ? hits.length / nFcst : 0;
    dirRecall = recall;
    dirPrecision = precision;
    dirHits = hits.length;
    dirObs = nObs;
    // Timing: 0 at boundary (3h), 1 at perfect (0h)
    applyComponent(recall, precision, hits, 0.35, (h) =>
      Math.max(0, 1 - Math.abs(h.fcst.t - h.obs.t) / COMPOSITE_TIMING_TOL_MS)
    );
    // Magnitude: 0 at boundary (15°), 1 at perfect (0°)
    applyComponent(recall, precision, hits, 0.20, (h) =>
      Math.max(
        0,
        1 - ((Math.abs(h.fcst.v - h.obs.v) * 180) / Math.PI) / COMPOSITE_DIR_TOL_DEG
      )
    );
  }

  if (hasSpdEvents) {
    const { hits, misses, falseAlarms } = matchEvents(
      obsSpdEvents,
      fcstSpdEvents,
      COMPOSITE_TIMING_TOL_MS
    );
    const nObs = hits.length + misses.length;
    const nFcst = hits.length + falseAlarms.length;
    const recall = nObs > 0 ? hits.length / nObs : 0;
    const precision = nFcst > 0 ? hits.length / nFcst : 0;
    applyComponent(recall, precision, hits, 0.20, (h) =>
      Math.max(0, 1 - Math.abs(h.fcst.t - h.obs.t) / COMPOSITE_TIMING_TOL_MS)
    );
    applyComponent(recall, precision, hits, 0.15, (h) =>
      Math.max(0, 1 - Math.abs(h.fcst.v - h.obs.v) / COMPOSITE_SPD_TOL_MS)
    );
  }

  const score = totalWeight > 0 ? totalScore / totalWeight : null;
  return { score, recall: dirRecall, precision: dirPrecision, hits: dirHits, obsEvents: dirObs };
}

// Cheap stable fingerprint of a forecast's hourly payload. Two fetches whose
// hours are identical are the *same* model run re-served by the provider.
function fingerprintHours(hours) {
  let s = "";
  for (const h of hours) s += h.t + ":" + h.dir + ":" + h.speed + ";";
  return s;
}

// Attribute every fetched run to the true model run that produced it.
//
// Open-Meteo does not report model init time and re-serves the same run across
// several fetches (measured on real data: ~2.9× on average, up to 7× for
// ECMWF). Left uncorrected, one run is treated as many, each stamped with a
// different fetch time — so a single forecast for a given valid time is scored
// at several different (fake) lead times. Here we detect identical re-serves
// per (model, location) and rewrite each run's effective run time to the
// *first* fetch at which that exact content appeared. That first-seen time is
// the best available proxy for init time and the correct origin for lead time.
//
// Note: first-seen still lags true init by the provider's publish latency
// (larger for ECMWF than for MET Norway); recovering absolute init would need a
// provider that reports it or a per-model schedule table. What this fixes is
// the dominant error — the same run being counted at many phantom lead times.
//
// Returns the records sorted by fetch time, each carrying `_runTime`.
function attributeRunTimes(forecasts) {
  const sorted = [...forecasts].sort((a, b) => a.runTime - b.runTime);
  const firstSeen = new Map(); // "model|loc" -> Map<fingerprint, runTime>
  for (const r of sorted) {
    const key = `${r.model}|${r.location}`;
    if (!firstSeen.has(key)) firstSeen.set(key, new Map());
    const seen = firstSeen.get(key);
    const fp = fingerprintHours(r.hours);
    if (!seen.has(fp)) seen.set(fp, r.runTime);
    r._runTime = seen.get(fp);
  }
  return sorted;
}

// Reduce a bucket's deduplicated (valid-time -> pair) map into aggregate stats.
function reduceCell(pairMap) {
  let n = 0, sumAbs = 0, sumSigned = 0, sumDirScore = 0;
  let nSpeed = 0, sumSpeedAbs = 0, sumSpeedScore = 0, sumVec2 = 0;
  let nPersist = 0, sumPersistAbs = 0;
  for (const p of pairMap.values()) {
    const dErr = normalize(p.fDir - p.o.dir);
    const dErrDeg = (Math.abs(dErr) * 180) / Math.PI;
    n++;
    sumAbs += Math.abs(dErr);
    sumSigned += dErr;
    sumDirScore += Math.max(0, 1 - dErrDeg / 90);
    if (p.fSpeed != null && typeof p.o.speed === "number") {
      const sErr = Math.abs(p.fSpeed - p.o.speed);
      nSpeed++;
      sumSpeedAbs += sErr;
      sumSpeedScore += Math.max(0, 1 - sErr / SCORE_SPEED_SCALE_MS);
      const dx = p.fSpeed * Math.sin(p.fDir) - p.o.speed * Math.sin(p.o.dir);
      const dy = p.fSpeed * Math.cos(p.fDir) - p.o.speed * Math.cos(p.o.dir);
      sumVec2 += dx * dx + dy * dy;
    }
    if (p.baseObs) {
      nPersist++;
      sumPersistAbs += Math.abs(normalize(p.baseObs.dir - p.o.dir));
    }
  }
  return { n, sumAbs, sumSigned, sumDirScore, nSpeed, sumSpeedAbs, sumSpeedScore, sumVec2, nPersist, sumPersistAbs };
}

// Pair archived forecasts with observations and aggregate error statistics
// per (location, model, lead-time bucket) over the verification window.
//
// Two corrections vs. a naive point-by-point pass:
//   1. Lead time is measured from each forecast's *attributed run time*
//      (see attributeRunTimes), not from the fetch that happened to serve it.
//   2. Each (bucket, valid time) contributes exactly one verification — the
//      freshest run whose lead lands in that bucket — instead of one per fetch.
//      This removes a ~28× autocorrelated over-count that made `n` and every
//      error average misleading. The pre-dedup count is kept as `nRaw`.
//
// Every pair also gets a persistence comparison: "the wind stays as it was at
// the run's init". A model only has skill if it beats that.
//
// Each model entry also receives a `composite` score (0–1) computed from
// change-event detection across the full ≤48h lead-time horizon.
function computeScoreboard({ forecasts, observations, now, windowDays }) {
  const TOL_MS = 15 * 60 * 1000;
  const windowStart = now - windowDays * 86400000;

  const obsByLoc = new Map();
  for (const o of observations) {
    if (typeof o.dir !== "number") continue;
    if (!obsByLoc.has(o.location)) obsByLoc.set(o.location, []);
    obsByLoc.get(o.location).push(o);
  }
  for (const arr of obsByLoc.values()) arr.sort((a, b) => a.t - b.t);

  // Collapse re-served fetches back onto their true runs before scoring.
  const runs = attributeRunTimes(forecasts);

  // acc: loc -> model -> BUCKETS.map(Map<validTime, pair>) — deduped pairs.
  // rawCounts: loc -> model -> BUCKETS.map(int) — pairs before dedup (nRaw).
  const acc = new Map();
  const rawCounts = new Map();

  // forecastSeries: "loc|model" -> Map<validTime_ms, {t, dir, speed, runTime}>
  // Latest run's forecast per valid time, for composite scoring.
  const forecastSeries = new Map();

  const cellsFor = (loc, model) => {
    if (!acc.has(loc)) {
      acc.set(loc, new Map());
      rawCounts.set(loc, new Map());
    }
    const m = acc.get(loc);
    const rc = rawCounts.get(loc);
    if (!m.has(model)) {
      m.set(model, BUCKETS.map(() => new Map()));
      rc.set(model, BUCKETS.map(() => 0));
    }
    return { cells: m.get(model), raw: rc.get(model) };
  };

  for (const run of runs) {
    const runTime = run._runTime != null ? run._runTime : run.runTime;
    const obs = obsByLoc.get(run.location);
    if (!obs || obs.length === 0) continue;
    const baseObs = nearestObs(obs, runTime, 2 * TOL_MS);
    const seriesKey = `${run.location}|${run.model}`;

    for (const h of run.hours) {
      if (h.t > now || h.t < windowStart || h.t < runTime) continue;
      const leadMs = h.t - runTime;
      const bi = bucketIndexForLead(leadMs);

      // One deduped verification per (bucket, valid time): freshest run wins.
      if (bi >= 0) {
        const o = nearestObs(obs, h.t, TOL_MS);
        if (o) {
          const { cells, raw } = cellsFor(run.location, run.model);
          raw[bi]++;
          const cellMap = cells[bi];
          const existing = cellMap.get(h.t);
          if (!existing || runTime > existing.runTime) {
            cellMap.set(h.t, {
              runTime,
              o,
              fDir: h.dir,
              fSpeed: typeof h.speed === "number" ? h.speed : null,
              baseObs,
            });
          }
        }
      }

      // Build deduplicated forecast series for composite (≤48h lead only)
      if (leadMs <= COMPOSITE_MAX_LEAD_MS) {
        if (!forecastSeries.has(seriesKey)) forecastSeries.set(seriesKey, new Map());
        const series = forecastSeries.get(seriesKey);
        const existing = series.get(h.t);
        if (!existing || runTime > existing.runTime) {
          series.set(h.t, {
            t: h.t,
            dir: h.dir,
            speed: typeof h.speed === "number" ? h.speed : null,
            runTime,
          });
        }
      }
    }
  }

  const toDeg = (r) => (r * 180) / Math.PI;
  const locations = [];
  for (const [loc, models] of acc) {
    const obsPts = (obsByLoc.get(loc) || []).filter(
      (o) => o.t >= windowStart && o.t <= now
    );
    const rcModels = rawCounts.get(loc);
    const entry = { label: loc, models: [] };
    for (const [model, cells] of models) {
      const seriesKey = `${loc}|${model}`;
      const seriesMap = forecastSeries.get(seriesKey);
      const fcstPts = seriesMap
        ? [...seriesMap.values()].sort((a, b) => a.t - b.t)
        : [];
      const raw = rcModels.get(model);

      entry.models.push({
        model,
        composite: computeComposite(obsPts, fcstPts),
        buckets: cells.map((pairMap, i) => {
          const c = reduceCell(pairMap);
          const dirMAE = c.n ? c.sumAbs / c.n : null;
          const persistMAE = c.nPersist ? c.sumPersistAbs / c.nPersist : null;
          const dirSkill = dirMAE != null && persistMAE ? 1 - dirMAE / persistMAE : null;
          const speedMAE = c.nSpeed ? c.sumSpeedAbs / c.nSpeed : null;
          // M6 weighted score: 0.7 × dir_score + 0.3 × speed_score
          // dir_score = mean(1 - |err°|/180),  speed_score = mean(1 - |err_ms|/5)
          // Falls back to direction-only when speed data is absent.
          const dirScore = c.n ? c.sumDirScore / c.n : null;
          const speedScore = c.nSpeed ? c.sumSpeedScore / c.nSpeed : null;
          const score =
            dirScore != null && speedScore != null
              ? 0.7 * dirScore + 0.3 * speedScore
              : dirScore;
          return {
            id: BUCKETS[i].id,
            n: c.n,           // deduped — honest independent-ish sample count
            nRaw: raw[i],     // pre-dedup pairs (for transparency/debugging)
            score,
            dirMAE_deg: dirMAE != null ? toDeg(dirMAE) : null,
            dirBias_deg: c.n ? toDeg(c.sumSigned / c.n) : null,
            speedMAE_ms: speedMAE,
            vectorRMSE_ms: c.nSpeed ? Math.sqrt(c.sumVec2 / c.nSpeed) : null,
            persistenceMAE_deg: persistMAE != null ? toDeg(persistMAE) : null,
            skill: dirSkill,
          };
        }),
      });
    }
    entry.models.sort((a, b) => a.model.localeCompare(b.model));
    locations.push(entry);
  }
  locations.sort((a, b) => a.label.localeCompare(b.label));

  return { generatedAt: now, windowDays, buckets: BUCKETS, locations };
}

module.exports = {
  normalize,
  normalize2pi,
  circularMeanFromSums,
  BUCKETS,
  bucketIndexForLead,
  nearestObs,
  unwrapDir,
  zigzagEvents,
  matchEvents,
  smoothHourly,
  computeComposite,
  fingerprintHours,
  attributeRunTimes,
  computeScoreboard,
};
