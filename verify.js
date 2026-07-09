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

// Pair archived forecasts with observations and aggregate error statistics
// per (location, model, lead-time bucket) over the verification window.
//
// Every pair also gets a persistence comparison: "the wind stays as it was
// when the forecast was fetched". A model only has skill if it beats that.
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
          nSpeed: 0,
          sumSpeedAbs: 0,
          sumVec2: 0,
          nPersist: 0,
          sumPersistAbs: 0,
        }))
      );
    }
    return m.get(model);
  };

  for (const run of forecasts) {
    const obs = obsByLoc.get(run.location);
    if (!obs || obs.length === 0) continue;
    // persistence anchor: what the wind actually was around fetch time
    const baseObs = nearestObs(obs, run.runTime, 2 * TOL_MS);

    for (const h of run.hours) {
      if (h.t > now || h.t < windowStart || h.t < run.runTime) continue;
      const bi = bucketIndexForLead(h.t - run.runTime);
      if (bi < 0) continue;
      const o = nearestObs(obs, h.t, TOL_MS);
      if (!o) continue;

      const cell = cellsFor(run.location, run.model)[bi];
      const dErr = normalize(h.dir - o.dir);
      cell.n++;
      cell.sumAbs += Math.abs(dErr);
      cell.sumSigned += dErr;

      if (typeof h.speed === "number" && typeof o.speed === "number") {
        cell.nSpeed++;
        cell.sumSpeedAbs += Math.abs(h.speed - o.speed);
        const dx = h.speed * Math.sin(h.dir) - o.speed * Math.sin(o.dir);
        const dy = h.speed * Math.cos(h.dir) - o.speed * Math.cos(o.dir);
        cell.sumVec2 += dx * dx + dy * dy;
      }

      if (baseObs) {
        cell.nPersist++;
        cell.sumPersistAbs += Math.abs(normalize(baseObs.dir - o.dir));
      }
    }
  }

  const toDeg = (r) => (r * 180) / Math.PI;
  const locations = [];
  for (const [loc, models] of acc) {
    const entry = { label: loc, models: [] };
    for (const [model, cells] of models) {
      entry.models.push({
        model,
        buckets: cells.map((c, i) => {
          const dirMAE = c.n ? c.sumAbs / c.n : null;
          const persistMAE = c.nPersist ? c.sumPersistAbs / c.nPersist : null;
          return {
            id: BUCKETS[i].id,
            n: c.n,
            dirMAE_deg: dirMAE != null ? toDeg(dirMAE) : null,
            dirBias_deg: c.n ? toDeg(c.sumSigned / c.n) : null,
            speedMAE_ms: c.nSpeed ? c.sumSpeedAbs / c.nSpeed : null,
            vectorRMSE_ms: c.nSpeed ? Math.sqrt(c.sumVec2 / c.nSpeed) : null,
            persistenceMAE_deg: persistMAE != null ? toDeg(persistMAE) : null,
            skill:
              dirMAE != null && persistMAE ? 1 - dirMAE / persistMAE : null,
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
  computeScoreboard,
};
