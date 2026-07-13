"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  fingerprintHours,
  attributeRunTimes,
  computeScoreboard,
} = require("../verify.js");

const HOUR = 3600 * 1000;
const deg = (d) => (d * Math.PI) / 180;

// Build an hours array from [{lead_h, dir_deg, speed}] anchored at runTime.
function hoursFrom(runTime, spec) {
  return spec.map((s) => ({
    t: runTime + s.lead_h * HOUR,
    dir: deg(s.dir),
    speed: s.speed,
  }));
}

test("fingerprintHours is stable and content-sensitive", () => {
  const a = [{ t: 1, dir: 0.5, speed: 3 }, { t: 2, dir: 0.6, speed: 4 }];
  const b = [{ t: 1, dir: 0.5, speed: 3 }, { t: 2, dir: 0.6, speed: 4 }];
  const c = [{ t: 1, dir: 0.5, speed: 3 }, { t: 2, dir: 0.61, speed: 4 }];
  assert.strictEqual(fingerprintHours(a), fingerprintHours(b));
  assert.notStrictEqual(fingerprintHours(a), fingerprintHours(c));
});

test("attributeRunTimes collapses identical re-serves to first-seen", () => {
  const t0 = 1_000_000_000_000;
  const hours = hoursFrom(t0, [{ lead_h: 24, dir: 200, speed: 5 }]);
  // three fetches, identical content, 3h apart -> same run
  const forecasts = [
    { model: "m", location: "x", runTime: t0, hours },
    { model: "m", location: "x", runTime: t0 + 3 * HOUR, hours: hours.map((h) => ({ ...h })) },
    { model: "m", location: "x", runTime: t0 + 6 * HOUR, hours: hours.map((h) => ({ ...h })) },
    // a genuinely new run: content changed
    { model: "m", location: "x", runTime: t0 + 9 * HOUR, hours: hoursFrom(t0, [{ lead_h: 24, dir: 260, speed: 6 }]) },
  ];
  const out = attributeRunTimes(forecasts);
  assert.strictEqual(out[0]._runTime, t0);
  assert.strictEqual(out[1]._runTime, t0, "identical re-serve keeps first-seen runTime");
  assert.strictEqual(out[2]._runTime, t0);
  assert.strictEqual(out[3]._runTime, t0 + 9 * HOUR, "changed content is a new run");
});

test("identical re-serves do not inflate n; nRaw records the raw count", () => {
  const t0 = 1_000_000_000_000;
  const now = t0 + 30 * HOUR;
  // one run forecasting 6 valid times, re-served identically 3 times
  const spec = [1, 2, 3, 6, 12, 24].map((lead_h) => ({ lead_h, dir: 200, speed: 5 }));
  const hours = hoursFrom(t0, spec);
  const forecasts = [0, 3, 6].map((off) => ({
    model: "m",
    location: "x",
    runTime: t0 + off * HOUR,
    hours: hours.map((h) => ({ ...h })),
  }));
  // observation exactly matching the forecast at each valid time (error 0)
  const observations = spec.map((s) => ({
    t: t0 + s.lead_h * HOUR,
    location: "x",
    dir: deg(s.dir),
    speed: s.speed,
  }));

  const sb = computeScoreboard({ forecasts, observations, now, windowDays: 7 });
  const model = sb.locations[0].models[0];
  const sumN = model.buckets.reduce((a, b) => a + b.n, 0);
  const sumRaw = model.buckets.reduce((a, b) => a + b.nRaw, 0);

  assert.strictEqual(sumN, 6, "one verification per valid time, not per fetch");
  assert.strictEqual(sumRaw, 18, "three identical fetches counted raw");
  // perfect forecast -> score 1.0, dirMAE 0
  for (const b of model.buckets) {
    if (b.n === 0) continue;
    assert.ok(Math.abs(b.dirMAE_deg) < 1e-6, "zero direction error");
    assert.ok(b.score > 0.999, "perfect forecast scores ~1");
  }
});

test("dedup keeps the freshest run whose lead lands in the same bucket", () => {
  const t0 = 1_000_000_000_000;
  const V = t0 + 24 * HOUR; // valid time
  const now = V + 2 * HOUR;
  // run 1 at t0: lead 24h -> "24h" bucket, forecasts 200°
  // run 2 at t0+3h (changed content): lead 21h -> also "24h" bucket, forecasts 260°
  const run1 = { model: "m", location: "x", runTime: t0, hours: [{ t: V, dir: deg(200), speed: 5 }] };
  const run2 = { model: "m", location: "x", runTime: t0 + 3 * HOUR, hours: [{ t: V, dir: deg(260), speed: 5 }] };
  // observation is 200° -> run1 would be perfect, run2 off by 60°
  const observations = [{ t: V, location: "x", dir: deg(200), speed: 5 }];

  const sb = computeScoreboard({ forecasts: [run1, run2], observations, now, windowDays: 7 });
  const cell = sb.locations[0].models[0].buckets.find((b) => b.id === "24h");
  assert.strictEqual(cell.n, 1, "single verification for this valid time+bucket");
  assert.strictEqual(cell.nRaw, 2, "both runs seen before dedup");
  assert.ok(Math.abs(cell.dirMAE_deg - 60) < 1e-6, "freshest (run2) wins -> 60° error");
});
