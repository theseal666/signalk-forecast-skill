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
const COMPOSITE_DIR_THRESHOLD_RAD = (10 * Math.PI) / 180; // ≥10° swing confirms dir event
const COMPOSITE_SPD_THRESHOLD_MS = 1.5;                   // ≥1.5 m/s swing confirms spd event
const COMPOSITE_TIMING_TOL_MS = 3 * 3600 * 1000;          // ±3h matching window + timing score
const COMPOSITE_DIR_TOL_DEG = 15;                         // ±15° magnitude tolerance
const COMPOSITE_SPD_TOL_MS = 1.5;                         // ±1.5 m/s magnitude tolerance
const COMPOSITE_MIN_OBS_EVENTS = 2;                       // refuse to score with < 2 observed events
const COMPOSITE_MAX_LEAD_MS = 48 * 3600 * 1000;           // only score forecasts ≤ 48h lead

// Composite score (0–1) for one (location, model) pair over the verification window.
//
// Component weights (sum to 1 when both dir and speed data are present):
//   0.35 — direction-event timing
//   0.20 — direction-event magnitude
//   0.20 — speed-event timing
//   0.15 — speed-event magnitude
//   0.10 — baro (reserved; not yet implemented)
//
// If speed data is absent the speed weights are redistributed to direction.
// Result is null when there are not enough events to make a meaningful score.
//
// obsPts: [{t, dir (rad), speed? (m/s)}] sorted by t
// fcstPts: [{t, dir (rad), speed? (m/s)}] — ≤48h lead, deduped by valid time (latest run wins)
function computeComposite(obsPts, fcstPts) {
  if (obsPts.length < 5 || fcstPts.length < 5) return null;

  const obsDir = unwrapDir(obsPts.map((p) => ({ t: p.t, v: p.dir })));
  const fcstDir = unwrapDir(fcstPts.map((p) => ({ t: p.t, v: p.dir })));
  const obsEvents = zigzagEvents(obsDir, COMPOSITE_DIR_THRESHOLD_RAD);
  const fcstEvents = zigzagEvents(fcstDir, COMPOSITE_DIR_THRESHOLD_RAD);

  const obsSpd = obsPts.filter((p) => p.speed != null).map((p) => ({ t: p.t, v: p.speed }));
  const fcstSpd = fcstPts.filter((p) => p.speed != null).map((p) => ({ t: p.t, v: p.speed }));
  const obsSpdEvents = zigzagEvents(obsSpd, COMPOSITE_SPD_THRESHOLD_MS);
  const fcstSpdEvents = zigzagEvents(fcstSpd, COMPOSITE_SPD_THRESHOLD_MS);

  const hasDirEvents = obsEvents.length >= COMPOSITE_MIN_OBS_EVENTS;
  const hasSpdEvents = obsSpdEvents.length >= COMPOSITE_MIN_OBS_EVENTS;
  if (!hasDirEvents && !hasSpdEvents) return null;

  let totalWeight = 0;
  let totalScore = 0;

  // Accumulate one component: weight × recall × precision × mean-hit-score.
  // Separating timing and magnitude scoring over the same hit set correctly
  // attributes independent F1 penalties for each quality dimension.
  function applyComponent(hits, misses, falseAlarms, weight, scoreFn) {
    const nObs = hits.length + misses.length;
    const nFcst = hits.length + falseAlarms.length;
    const recall = nObs > 0 ? hits.length / nObs : 0;
    const precision = nFcst > 0 ? hits.length / nFcst : 0;
    const meanHit =
      hits.length > 0
        ? hits.reduce((s, h) => s + scoreFn(h), 0) / hits.length
        : 0;
    totalScore += weight * recall * precision * meanHit;
    totalWeight += weight;
  }

  if (hasDirEvents) {
    const { hits, misses, falseAlarms } = matchEvents(
      obsEvents,
      fcstEvents,
      COMPOSITE_TIMING_TOL_MS
    );
    // Timing: 0 at boundary (3h), 1 at perfect (0h)
    applyComponent(hits, misses, falseAlarms, 0.35, (h) =>
      Math.max(0, 1 - Math.abs(h.fcst.t - h.obs.t) / COMPOSITE_TIMING_TOL_MS)
    );
    // Magnitude: 0 at boundary (15°), 1 at perfect (0°)
    applyComponent(hits, misses, falseAlarms, 0.20, (h) =>
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
    applyComponent(hits, misses, falseAlarms, 0.20, (h) =>
      Math.max(0, 1 - Math.abs(h.fcst.t - h.obs.t) / COMPOSITE_TIMING_TOL_MS)
    );
    applyComponent(hits, misses, falseAlarms, 0.15, (h) =>
      Math.max(0, 1 - Math.abs(h.fcst.v - h.obs.v) / COMPOSITE_SPD_TOL_MS)
    );
  }

  return totalWeight > 0 ? totalScore / totalWeight : null;
}

// Pair archived forecasts with observations and aggregate error statistics
// per (location, model, lead-time bucket) over the verification window.
//
// Every pair also gets a persistence comparison: "the wind stays as it was
// when the forecast was fetched". A model only has skill if it beats that.
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

  const acc = new Map(); // loc -> model -> per-bucket accumulator

  // forecastSeries: "loc|model" -> Map<validTime_ms, {t, dir, speed, runTime}>
  // Tracks the latest run's forecast for each valid time, for composite scoring.
  const forecastSeries = new Map();

  const cellsFor = (loc, model) => {
    if (!acc.has(loc)) acc.set(loc, new Map());
    const m = acc.get(loc);
    if (!m.has(model)) {
      m.set(
        model,
        BUCKETS.map(() => ({
          n: 0,
          sumAbs: 0,
          sumSigned: 0,
          sumDirScore: 0,   // sum of max(0, 1 - |err°|/180) — M6 formula
          nSpeed: 0,
          sumSpeedAbs: 0,
          sumSpeedScore: 0, // sum of max(0, 1 - |err_ms|/SCORE_SPEED_SCALE_MS)
          sumVec2: 0,
          nPersist: 0,
          sumPersistAbs: 0,
          nPersistSpeed: 0,
          sumPersistSpeedAbs: 0,
        }))
      );
    }
    return m.get(model);
  };

  for (const run of forecasts) {
    const obs = obsByLoc.get(run.location);
    if (!obs || obs.length === 0) continue;
    const baseObs = nearestObs(obs, run.runTime, 2 * TOL_MS);
    const seriesKey = `${run.location}|${run.model}`;

    for (const h of run.hours) {
      if (h.t > now || h.t < windowStart || h.t < run.runTime) continue;
      const leadMs = h.t - run.runTime;
      const bi = bucketIndexForLead(leadMs);

      // Point-by-point error accumulation (existing scoreboard logic)
      if (bi >= 0) {
        const o = nearestObs(obs, h.t, TOL_MS);
        if (o) {
          const cell = cellsFor(run.location, run.model)[bi];
          const dErr = normalize(h.dir - o.dir);
          const dErrDeg = Math.abs(dErr) * 180 / Math.PI;
          cell.n++;
          cell.sumAbs += Math.abs(dErr);
          cell.sumSigned += dErr;
          cell.sumDirScore += Math.max(0, 1 - dErrDeg / 180);
          if (typeof h.speed === "number" && typeof o.speed === "number") {
            const sErr = Math.abs(h.speed - o.speed);
            cell.nSpeed++;
            cell.sumSpeedAbs += sErr;
            cell.sumSpeedScore += Math.max(0, 1 - sErr / SCORE_SPEED_SCALE_MS);
            const dx = h.speed * Math.sin(h.dir) - o.speed * Math.sin(o.dir);
            const dy = h.speed * Math.cos(h.dir) - o.speed * Math.cos(o.dir);
            cell.sumVec2 += dx * dx + dy * dy;
          }
          if (baseObs) {
            cell.nPersist++;
            cell.sumPersistAbs += Math.abs(normalize(baseObs.dir - o.dir));
            if (typeof o.speed === "number" && typeof baseObs.speed === "number") {
              cell.nPersistSpeed++;
              cell.sumPersistSpeedAbs += Math.abs(baseObs.speed - o.speed);
            }
          }
        }
      }

      // Build deduplicated forecast series for composite (≤48h lead only)
      if (leadMs <= COMPOSITE_MAX_LEAD_MS) {
        if (!forecastSeries.has(seriesKey)) forecastSeries.set(seriesKey, new Map());
        const series = forecastSeries.get(seriesKey);
        const existing = series.get(h.t);
        if (!existing || run.runTime > existing.runTime) {
          series.set(h.t, {
            t: h.t,
            dir: h.dir,
            speed: typeof h.speed === "number" ? h.speed : null,
            runTime: run.runTime,
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
    const entry = { label: loc, models: [] };
    for (const [model, cells] of models) {
      const seriesKey = `${loc}|${model}`;
      const seriesMap = forecastSeries.get(seriesKey);
      const fcstPts = seriesMap
        ? [...seriesMap.values()].sort((a, b) => a.t - b.t)
        : [];

      entry.models.push({
        model,
        composite: computeComposite(obsPts, fcstPts),
        buckets: cells.map((c, i) => {
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
            n: c.n,
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
  computeComposite,
  computeScoreboard,
};
