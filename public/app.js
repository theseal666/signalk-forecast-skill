// Forecast Skill webapp — built to answer three questions:
//   1. What forecast has been the best match at this station?  (#ranking)
//   2. Which should I choose?                                  (#reco)
//   3. Is there a reason to switch model by horizon?           (#horizon)
// Everything else (per lead-time metrics) lives in the collapsible detail panel.

let scoreboard = null;
let currentLocation = null;
let currentMetric = "score";

// Lead-time groupings a sailor actually thinks in.
// The ranking/recommendation window is exactly the union of the two near
// horizons (now + race), so the headline pick can never contradict both of
// them. The day-before horizon sits outside it — that is where a flip is the
// intended Q3 signal.
const HORIZONS = [
  { id: "now", label: "Now → 3 h", ids: ["1h", "2h", "3h"] },
  { id: "morning", label: "Race · 6 → 12 h", ids: ["6h", "12h"] },
  { id: "before", label: "Day before · 24 h+", ids: ["24h", "2d"] },
];
const RACE_BUCKETS = ["1h", "2h", "3h", "6h", "12h"]; // = now ∪ race horizons

const METRIC_META = {
  score:        { unit: "%", lowerBetter: false, digits: 0, scale: 100 },
  dirMAE_deg:   { unit: "°", lowerBetter: true, digits: 1 },
  dirBias_deg:  { unit: "°", lowerBetter: true, signed: true, digits: 1 },
  skill:        { unit: "", lowerBetter: false, digits: 2, diverging: true, halfScale: 1.0 },
  speedMAE_ms:  { unit: " m/s", lowerBetter: true, digits: 1 },
  vectorRMSE_ms: { unit: " m/s", lowerBetter: true, digits: 1 },
};

function fetchScoreboard() {
  return fetch("/api/scoreboard")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

function locationEntry() {
  if (!scoreboard) return null;
  return scoreboard.locations.find((l) => l.label === currentLocation) || null;
}

function modelLabel(id) {
  return (scoreboard && scoreboard.modelLabels && scoreboard.modelLabels[id]) || id;
}

// Hardcoded 24-hour HH:MM:SS — no reliance on the browser's locale/Intl support.
function formatSwedishTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Green (good) → red (bad) across a 0..1 badness ratio
function colorFor(badness) {
  const hue = (1 - Math.max(0, Math.min(1, badness))) * 120;
  return `hsl(${hue}, 62%, 45%)`;
}

// Average a bucket metric over a set of lead-time bucket ids (skips empties).
function bavg(model, ids, key) {
  let s = 0;
  let n = 0;
  for (const id of ids) {
    const c = model.buckets.find((b) => b.id === id);
    if (c && c.n > 0 && c[key] != null) {
      s += c[key];
      n++;
    }
  }
  return n ? s / n : null;
}

// Distil one model into the numbers the plain-language summary needs.
function summarize(model) {
  const race = RACE_BUCKETS;
  const matchScore = bavg(model, race, "score");
  const mae = bavg(model, race, "dirMAE_deg");
  const bias = bavg(model, race, "dirBias_deg");
  const comp = model.composite || {};
  const catchRate = comp.obsEvents > 0 ? comp.hits / comp.obsEvents : null;
  let skillCross = null;
  for (const id of ["3h", "6h", "12h", "24h", "2d", "3d"]) {
    const c = model.buckets.find((b) => b.id === id);
    if (c && c.skill != null && c.skill > 0) {
      skillCross = id;
      break;
    }
  }
  return {
    model: model.model,
    matchScore,
    mae,
    bias,
    hits: comp.hits || 0,
    obsEvents: comp.obsEvents || 0,
    catchRate,
    timingBiasMin: comp.dirTimingBiasMin,
    skillCross,
  };
}

// Best model over a horizon by match score. Returns {model, v} or null.
function bestOver(loc, ids) {
  let best = null;
  for (const m of loc.models) {
    const v = bavg(m, ids, "score");
    if (v == null) continue;
    if (!best || v > best.v) best = { model: m.model, v };
  }
  return best;
}

function biasPhrase(bias) {
  if (bias == null) return "";
  const n = Math.round(bias);
  if (n === 0) return "no steady bias";
  return `reads ${n > 0 ? "+" : ""}${n}° (${n > 0 ? "right" : "left"})`;
}

// timingBiasMin > 0 means the model predicts shifts later than they actually
// happen ("runs late"); < 0 means it calls them before they happen ("runs
// early"). Catching the shift at all is what's scored — this is purely
// informational, so you know which way to mentally nudge the clock.
function timingPhrase(timingBiasMin) {
  if (timingBiasMin == null) return "";
  if (Math.abs(timingBiasMin) < 5) return "right on time";
  const mins = Math.abs(timingBiasMin);
  const unit = mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}min`;
  return `runs ~${unit} ${timingBiasMin > 0 ? "late" : "early"}`;
}

// ---------- Q2: recommendation ----------
function renderReco(loc, summaries) {
  const el = document.getElementById("reco");
  el.innerHTML = "";
  const ranked = summaries.filter((s) => s.matchScore != null).sort((a, b) => b.matchScore - a.matchScore);
  if (ranked.length === 0) {
    el.innerHTML = `<div class="reco-card waiting">Collecting data — give it a couple of days per station.</div>`;
    return;
  }
  const pick = ranked[0];

  // shift-catching leader (only trust it with enough real shifts)
  const catchers = summaries.filter((s) => s.obsEvents >= 3 && s.catchRate != null);
  let catchNote = "";
  if (catchers.length) {
    const cl = catchers.sort((a, b) => b.catchRate - a.catchRate)[0];
    if (cl.model !== pick.model && cl.catchRate - (pick.catchRate || 0) >= 0.2) {
      catchNote = ` But <strong>${modelLabel(cl.model)}</strong> catches more of the wind shifts (${cl.hits}/${cl.obsEvents}) — favour it if the race hinges on shifts.`;
    }
  }

  const corr =
    pick.bias != null && Math.abs(Math.round(pick.bias)) >= 3
      ? ` Apply a <strong>${Math.abs(Math.round(pick.bias))}° ${pick.bias > 0 ? "left" : "right"}</strong> correction before drawing laylines.`
      : "";

  const catchTxt = pick.obsEvents > 0 ? `catches ${pick.hits}/${pick.obsEvents} shifts` : "few shifts to judge yet";

  el.innerHTML = `
    <div class="reco-card">
      <div class="reco-eyebrow">Recommended for ${loc.label}</div>
      <div class="reco-pick">${modelLabel(pick.model)}
        <span class="reco-score" style="color:${colorFor(1 - pick.matchScore)}">${Math.round(pick.matchScore * 100)}%</span>
      </div>
      <div class="reco-why">≈${Math.round(pick.mae)}° average direction error, ${catchTxt}.${corr}${catchNote}</div>
    </div>`;
}

// ---------- Q1: best-match ranking with plain-language ----------
function renderRanking(loc, summaries) {
  const el = document.getElementById("ranking");
  el.innerHTML = "";
  const ranked = summaries.filter((s) => s.matchScore != null).sort((a, b) => b.matchScore - a.matchScore);
  if (ranked.length === 0) {
    el.innerHTML = `<div class="empty">no verified pairs yet</div>`;
    return;
  }
  ranked.forEach((s, i) => {
    const pct = Math.round(s.matchScore * 100);
    const parts = [];
    parts.push(
      `<span title="Average distance between forecast and observed wind direction, over 3–24 h lead. Smaller is better.">≈${Math.round(s.mae)}° off</span>`
    );
    if (s.bias != null && Math.abs(Math.round(s.bias)) >= 1) {
      parts.push(
        `<span title="Which way it leans on average. + = reads clockwise (right) of reality. Subtract this before laylines.">${biasPhrase(s.bias)}</span>`
      );
    }
    if (s.obsEvents > 0) {
      parts.push(
        `<span title="Of the ${s.obsEvents} tactically real wind shifts (≥20°, hourly-smoothed) observed this week, how many the model predicted within 3 h. Catching it counts fully regardless of how early or late within that window.">catches ${s.hits}/${s.obsEvents} shifts</span>`
      );
    }
    if (s.hits > 0 && s.timingBiasMin != null) {
      parts.push(
        `<span title="Average gap between predicted and actual shift time, across the ${s.hits} shifts it caught. Doesn't affect the score above — purely so you know which way to nudge the clock.">${timingPhrase(s.timingBiasMin)}</span>`
      );
    }
    parts.push(
      s.skillCross
        ? `<span title="Beyond this lead time the model beats simply assuming the wind never changes.">beats “no change” from ${s.skillCross}</span>`
        : `<span title="It has not yet beaten assuming the wind never changes at any lead time — treat with care.">no edge over “no change” yet</span>`
    );

    const row = document.createElement("div");
    row.className = "rank-card" + (i === 0 ? " top" : "");
    row.innerHTML = `
      <div class="rank-pos">${i + 1}</div>
      <div class="rank-body">
        <div class="rank-name">${modelLabel(s.model)}</div>
        <div class="rank-summary">${parts.join(" · ")}</div>
        <div class="rank-bar"><div class="rank-fill" style="width:${Math.max(3, pct)}%;background:${colorFor(1 - s.matchScore)}"></div></div>
      </div>
      <div class="rank-score" title="Match score: 100% = perfect, 0% = no better than a random guess (90° average error). Averaged over 3–24 h lead.">${pct}<span>%</span></div>`;
    el.appendChild(row);
  });
}

// ---------- Q3: does the winner change by horizon ----------
function renderHorizon(loc) {
  const el = document.getElementById("horizon");
  el.innerHTML = "";
  const picks = HORIZONS.map((h) => ({ ...h, best: bestOver(loc, h.ids) }));
  if (picks.every((p) => !p.best)) {
    el.innerHTML = `<div class="empty">not enough data across horizons yet</div>`;
    return;
  }

  const chips = document.createElement("div");
  chips.className = "horizon-row";
  picks.forEach((p) => {
    const chip = document.createElement("div");
    chip.className = "horizon-chip";
    const who = p.best
      ? `<strong>${modelLabel(p.best.model)}</strong> <span class="hz-score">${Math.round(p.best.v * 100)}%</span>`
      : "—";
    chip.innerHTML = `<div class="hz-label">${p.label}</div><div class="hz-pick">${who}</div>`;
    chips.appendChild(chip);
  });
  el.appendChild(chips);

  const models = picks.filter((p) => p.best).map((p) => p.best.model);
  const allSame = models.every((m) => m === models[0]);
  const verdict = document.createElement("div");
  verdict.className = "horizon-verdict";
  if (allSame) {
    verdict.innerHTML = `★ <strong>${modelLabel(models[0])}</strong> is best across every horizon — no reason to switch mid-race.`;
  } else {
    verdict.innerHTML = `The best model changes with horizon — trust the "Now" pick for the start, and re-check the day before.`;
  }
  el.appendChild(verdict);
}

// ---------- detail (collapsible per-lead-time chart) ----------
function makeBarLine(labelText, barWidthPct, color, valueText, note, barLeft) {
  const line = document.createElement("div");
  line.className = "bar-line";
  const name = document.createElement("div");
  name.className = "model-name";
  name.textContent = labelText;
  const track = document.createElement("div");
  track.className = "bar-track";
  const fill = document.createElement("div");
  if (barLeft != null) {
    track.classList.add("diverging");
    fill.className = "bar-fill diverging " + (barLeft >= 50 ? "skill-positive" : "skill-negative");
    fill.style.left = barLeft + "%";
    fill.style.width = barWidthPct + "%";
  } else {
    fill.className = "bar-fill";
    fill.style.width = Math.max(2, barWidthPct) + "%";
  }
  fill.style.backgroundColor = color;
  track.appendChild(fill);
  const val = document.createElement("div");
  val.className = "bar-value";
  val.innerHTML = valueText + (note ? ` <span class="bar-n">${note}</span>` : "");
  line.appendChild(name);
  line.appendChild(track);
  line.appendChild(val);
  return line;
}

function formatValue(v, meta) {
  if (v == null) return "–";
  const display = meta.scale != null ? v * meta.scale : v;
  const s = display.toFixed(meta.digits);
  return (meta.signed && display > 0 ? "+" : "") + s + meta.unit;
}

function renderDetail() {
  const chart = document.getElementById("chart");
  const hint = document.getElementById("hint");
  chart.innerHTML = "";
  const loc = locationEntry();
  if (!loc) {
    hint.textContent = "Waiting for data…";
    return;
  }
  hint.textContent = "";
  const meta = METRIC_META[currentMetric];
  const sel = document.getElementById("metric-select");
  document.getElementById("metric-label").textContent =
    "— " + sel.selectedOptions[0].text;

  scoreboard.buckets.forEach((bucket, bi) => {
    const rows = loc.models
      .map((m) => ({ model: m.model, cell: m.buckets[bi] }))
      .filter((r) => r.cell && r.cell.n > 0 && r.cell[currentMetric] != null);

    const row = document.createElement("div");
    row.className = "bucket-row";
    const label = document.createElement("div");
    label.className = "bucket-label";
    label.textContent = bucket.id;
    row.appendChild(label);
    const bars = document.createElement("div");
    bars.className = "bars";

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "no verified pairs yet";
      bars.appendChild(empty);
    } else {
      const maxMag = Math.max(...rows.map((r) => Math.abs(r.cell[currentMetric]))) || 1;
      rows.sort((a, b) => {
        const va = a.cell[currentMetric], vb = b.cell[currentMetric];
        return meta.lowerBetter ? va - vb : vb - va;
      });
      rows.forEach((r) => {
        const v = r.cell[currentMetric];
        const mag = Math.abs(v);
        let barPct, badness, barLeft = null;
        if (meta.diverging) {
          const halfScale = meta.halfScale || 1.0;
          const clamped = Math.max(-halfScale, Math.min(halfScale, v));
          barPct = Math.max(2, (Math.abs(clamped) / halfScale) * 50);
          badness = 1 - Math.max(0, Math.min(1, v));
          barLeft = clamped >= 0 ? 50 : 50 - barPct;
        } else if (meta.scale != null) {
          barPct = Math.max(2, Math.min(100, v * meta.scale));
          badness = 1 - Math.max(0, Math.min(1, v));
        } else {
          barPct = (mag / maxMag) * 100;
          badness = meta.lowerBetter ? mag / maxMag : 1 - Math.max(0, Math.min(1, v));
        }
        bars.appendChild(
          makeBarLine(modelLabel(r.model), barPct, colorFor(badness), formatValue(v, meta), `n=${r.cell.n}`, barLeft)
        );
      });
    }
    row.appendChild(bars);
    chart.appendChild(row);
  });
}

// ---------- forecast track charts (direction + speed over time) ----------
const TRACK_PAST_HOURS = 48;
const TRACK_FUTURE_HOURS = 48;
const TRACK_PX_PER_HOUR = 12;
const TRACK_HEIGHT = 220;
const TRACK_MARGIN = { top: 14, right: 16, bottom: 24, left: 44 };
const OBSERVED_COLOR = "#eee";

const MODEL_COLORS = {
  ecmwf_ifs025: "#4fc3f7",
  gfs_seamless: "#ffb74d",
  icon_seamless: "#ba68c8",
  metno_seamless: "#81c784",
  knmi_harmonie_arome_europe: "#f06292",
};

function colorForModel(id) {
  if (MODEL_COLORS[id]) return MODEL_COLORS[id];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 62%)`;
}

// Unwrap a direction series (radians) to a continuous line, no 360°/0° jump.
function unwrapSeries(pts) {
  if (pts.length === 0) return [];
  const out = [{ t: pts[0].t, v: pts[0].v }];
  for (let i = 1; i < pts.length; i++) {
    let diff = pts[i].v - pts[i - 1].v;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    out.push({ t: pts[i].t, v: out[i - 1].v + diff });
  }
  return out;
}

let tracksData = null; // last /api/curves response
let tracksRequestId = 0;

function fetchCurves(location) {
  return fetch(`/api/curves?location=${encodeURIComponent(location)}&pastHours=${TRACK_PAST_HOURS}&futureHours=${TRACK_FUTURE_HOURS}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

function renderTracksLegend() {
  const el = document.getElementById("tracks-legend");
  el.innerHTML = "";
  const items = [{ label: "Observed", color: OBSERVED_COLOR, dashed: false }];
  if (tracksData) {
    for (const model of Object.keys(tracksData.models)) {
      items.push({ label: modelLabel(model), color: colorForModel(model), dashed: true });
    }
  }
  items.forEach((it) => {
    const div = document.createElement("div");
    div.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.borderTopColor = it.color;
    sw.style.borderTopStyle = it.dashed ? "dashed" : "solid";
    div.appendChild(sw);
    const label = document.createElement("span");
    label.textContent = it.label;
    div.appendChild(label);
    el.appendChild(div);
  });
}

// Generic time-series line chart. accessor(pt) -> value or null. isAngle
// unwraps each series independently before scaling (shared Y axis after).
function renderTrackChart(svgId, scrollId, data, accessor, opts) {
  const svg = document.getElementById(svgId);
  const scroll = document.getElementById(scrollId);
  svg.innerHTML = "";
  if (!data) return;

  const { windowStart, windowEnd, observed, models, generatedAt } = data;
  const totalHours = (windowEnd - windowStart) / 3600000;
  const wrapperWidth = scroll.clientWidth || 600;
  const width = Math.max(wrapperWidth, Math.round(totalHours * TRACK_PX_PER_HOUR));
  const height = TRACK_HEIGHT;
  const plotW = width - TRACK_MARGIN.left - TRACK_MARGIN.right;
  const plotH = height - TRACK_MARGIN.top - TRACK_MARGIN.bottom;

  const toPts = (arr) =>
    arr.map((p) => ({ t: p.t, v: accessor(p) })).filter((p) => p.v != null);

  let obsPts = toPts(observed);
  const modelPts = {};
  for (const [m, arr] of Object.entries(models)) modelPts[m] = toPts(arr);

  if (opts.isAngle) {
    obsPts = unwrapSeries(obsPts);
    for (const m of Object.keys(modelPts)) modelPts[m] = unwrapSeries(modelPts[m]);
  }

  const allVals = [...obsPts, ...Object.values(modelPts).flat()].map((p) => p.v);
  let yMin = allVals.length ? Math.min(...allVals) : 0;
  let yMax = allVals.length ? Math.max(...allVals) : 1;
  if (opts.yMin != null) yMin = Math.min(yMin, opts.yMin);
  if (opts.yMax != null) yMax = Math.max(yMax, opts.yMax);
  const pad = (yMax - yMin) * 0.1 || 1;
  yMin -= pad;
  yMax += pad;

  const x = (t) => TRACK_MARGIN.left + ((t - windowStart) / (windowEnd - windowStart)) * plotW;
  const y = (v) => TRACK_MARGIN.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const ns = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  };

  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  // grid + y-axis labels
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const v = yMin + ((yMax - yMin) * i) / gridLines;
    const gy = y(v);
    svg.appendChild(
      el("line", { x1: TRACK_MARGIN.left, x2: width - TRACK_MARGIN.right, y1: gy, y2: gy, stroke: "#262626", "stroke-width": 1 })
    );
    const label = el("text", { x: TRACK_MARGIN.left - 8, y: gy + 4, fill: "#666", "font-size": 10, "text-anchor": "end" });
    label.textContent = opts.formatY ? opts.formatY(v) : Math.round(v);
    svg.appendChild(label);
  }

  // x-axis hour ticks
  const tickEveryH = totalHours > 60 ? 12 : 6;
  for (let h = 0; h <= totalHours; h += tickEveryH) {
    const t = windowStart + h * 3600000;
    const gx = x(t);
    svg.appendChild(el("line", { x1: gx, x2: gx, y1: TRACK_MARGIN.top, y2: height - TRACK_MARGIN.bottom, stroke: "#1e1e1e", "stroke-width": 1 }));
    const label = el("text", { x: gx, y: height - 8, fill: "#666", "font-size": 10, "text-anchor": "middle" });
    label.textContent = new Date(t).toLocaleString("sv-SE", { day: "2-digit", month: "2-digit" }).slice(0, 5) + " " + formatSwedishTime(t).slice(0, 5);
    svg.appendChild(label);
  }

  // "now" marker
  const nowX = x(generatedAt);
  svg.appendChild(el("line", { x1: nowX, x2: nowX, y1: TRACK_MARGIN.top, y2: height - TRACK_MARGIN.bottom, stroke: "#555", "stroke-width": 1.5, "stroke-dasharray": "3,3" }));
  const nowLabel = el("text", { x: nowX + 4, y: TRACK_MARGIN.top + 10, fill: "#888", "font-size": 10 });
  nowLabel.textContent = "now";
  svg.appendChild(nowLabel);

  const pathFor = (pts) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  if (obsPts.length > 1) {
    svg.appendChild(el("path", { d: pathFor(obsPts), fill: "none", stroke: OBSERVED_COLOR, "stroke-width": 2.5, "stroke-linejoin": "round" }));
  }
  for (const [m, pts] of Object.entries(modelPts)) {
    if (pts.length < 2) continue;
    svg.appendChild(
      el("path", {
        d: pathFor(pts),
        fill: "none",
        stroke: colorForModel(m),
        "stroke-width": 1.6,
        "stroke-dasharray": "5,4",
        "stroke-linejoin": "round",
      })
    );
  }

  // hover: vertical guide + tooltip
  scroll.style.position = "relative";
  let tooltip = scroll.querySelector(".track-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "track-tooltip";
    tooltip.style.display = "none";
    scroll.appendChild(tooltip);
  }
  const guide = el("line", { y1: TRACK_MARGIN.top, y2: height - TRACK_MARGIN.bottom, stroke: "#888", "stroke-width": 1, visibility: "hidden" });
  svg.appendChild(guide);

  const overlay = el("rect", {
    x: TRACK_MARGIN.left,
    y: TRACK_MARGIN.top,
    width: plotW,
    height: plotH,
    fill: "transparent",
  });
  overlay.addEventListener("mousemove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = windowStart + ((px - TRACK_MARGIN.left) / plotW) * (windowEnd - windowStart);
    guide.setAttribute("x1", px);
    guide.setAttribute("x2", px);
    guide.setAttribute("visibility", "visible");

    const nearest = (pts) => {
      if (!pts.length) return null;
      let best = pts[0];
      for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      return Math.abs(best.t - t) <= 1.5 * 3600000 ? best : null;
    };

    const rows = [];
    const ob = nearest(obsPts);
    if (ob) rows.push({ label: "Observed", color: OBSERVED_COLOR, v: ob.v, t: ob.t });
    for (const [m, pts] of Object.entries(modelPts)) {
      const mp = nearest(pts);
      if (mp) rows.push({ label: modelLabel(m), color: colorForModel(m), v: mp.v, t: mp.t });
    }
    if (rows.length === 0) {
      tooltip.style.display = "none";
      return;
    }
    const fmt = opts.formatTooltip || ((v) => v.toFixed(1));
    tooltip.innerHTML =
      `<div class="tt-time">${new Date(t).toLocaleString("sv-SE")}</div>` +
      rows
        .map(
          (r) =>
            `<div class="tt-row"><span class="tt-swatch" style="background:${r.color}"></span>${r.label}: ${fmt(r.v)}</div>`
        )
        .join("");
    tooltip.style.display = "block";
    const left = Math.min(px + 12, width - 180);
    tooltip.style.left = left + "px";
    tooltip.style.top = "8px";
  });
  overlay.addEventListener("mouseleave", () => {
    guide.setAttribute("visibility", "hidden");
    tooltip.style.display = "none";
  });
  svg.appendChild(overlay);
}

function renderTracks() {
  if (!currentLocation) return;
  const myRequest = ++tracksRequestId;
  fetchCurves(currentLocation).then((data) => {
    if (myRequest !== tracksRequestId) return; // location changed while in flight
    tracksData = data;
    renderTracksLegend();
    renderTrackChart("track-svg-dir", "track-scroll-dir", data, (p) => p.dir, {
      isAngle: true,
      formatY: (v) => Math.round(((v * 180) / Math.PI) % 360 < 0 ? ((v * 180) / Math.PI) % 360 + 360 : ((v * 180) / Math.PI) % 360) + "°",
      formatTooltip: (v) => {
        const deg = ((v * 180) / Math.PI) % 360;
        return Math.round(deg < 0 ? deg + 360 : deg) + "°";
      },
    });
    renderTrackChart("track-svg-speed", "track-scroll-speed", data, (p) => p.speed, {
      isAngle: false,
      yMin: 0,
      formatY: (v) => v.toFixed(0),
      formatTooltip: (v) => v.toFixed(1) + " m/s",
    });
  });
}

function render() {
  const loc = locationEntry();
  if (!scoreboard || !loc) return;
  const summaries = loc.models.map(summarize);
  renderReco(loc, summaries);
  renderRanking(loc, summaries);
  renderHorizon(loc);
  renderDetail();
  renderTracks();
}

function populateLocations() {
  const sel = document.getElementById("location-select");
  sel.innerHTML = "";
  if (!scoreboard || scoreboard.locations.length === 0) {
    const opt = document.createElement("option");
    opt.text = "no stations yet";
    sel.appendChild(opt);
    return;
  }
  const bp = scoreboard.boatPosition;
  const locs = scoreboard.locations.map((l) => {
    const distNm = bp && l.latitude != null ? haversineNm(bp.lat, bp.lon, l.latitude, l.longitude) : null;
    return { ...l, distNm };
  });
  if (bp) locs.sort((a, b) => (a.distNm ?? Infinity) - (b.distNm ?? Infinity));
  locs.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.label;
    const dist = l.distNm != null ? ` — ${l.distNm.toFixed(0)} nm` : "";
    opt.text = l.label + dist;
    sel.appendChild(opt);
  });
  if (!locs.some((l) => l.label === currentLocation)) currentLocation = locs[0].label;
  sel.value = currentLocation;
}

function refresh() {
  return fetchScoreboard().then((sb) => {
    if (!sb || !sb.locations) return;
    scoreboard = sb;
    populateLocations();
    document.getElementById("metric-select").value = currentMetric;
    document.getElementById("window-info").textContent =
      `${sb.windowDays}-day window · updated ${formatSwedishTime(sb.generatedAt)}`;
    render();
  });
}

// ---------- force update ----------
document.getElementById("force-update-btn").addEventListener("click", async () => {
  const btn = document.getElementById("force-update-btn");
  const info = document.getElementById("window-info");
  const prevInfo = info.textContent;
  btn.disabled = true;
  btn.classList.add("spinning");
  info.textContent = "Fetching latest forecasts…";
  try {
    const res = await fetch("/api/fetch-now", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "fetch failed");
    await refresh();
  } catch (e) {
    info.textContent = "Force update failed: " + e.message;
    setTimeout(() => { info.textContent = prevInfo; }, 4000);
  } finally {
    btn.disabled = false;
    btn.classList.remove("spinning");
  }
});

// ---------- settings panel ----------
let allStations = [];
// Source of truth for which stations are checked — kept independent of the
// DOM so filtering (which unmounts non-matching rows) can never drop a
// previously-checked station that's just scrolled out of the current search.
let selectedStationIdSet = new Set();

function renderStationChecklist(filterText) {
  const el = document.getElementById("cfg-stations");
  const q = (filterText || "").trim().toLowerCase();
  const rows = allStations.filter((s) => !q || s.name.toLowerCase().includes(q));
  el.innerHTML = "";
  if (rows.length === 0) {
    el.innerHTML = `<div class="empty">no stations match “${filterText}”</div>`;
    return;
  }
  rows.forEach((s) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = s.id;
    cb.checked = selectedStationIdSet.has(s.id);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedStationIdSet.add(s.id);
      else selectedStationIdSet.delete(s.id);
    });
    const name = document.createElement("span");
    name.textContent = s.name;
    const idSpan = document.createElement("span");
    idSpan.className = "station-id";
    idSpan.textContent = "#" + s.id;
    label.appendChild(cb);
    label.appendChild(name);
    label.appendChild(idSpan);
    el.appendChild(label);
  });
}

async function openSettings() {
  const errEl = document.getElementById("settings-error");
  errEl.textContent = "";
  document.getElementById("settings-btn").classList.add("spin");
  setTimeout(() => document.getElementById("settings-btn").classList.remove("spin"), 500);

  const [cfg, models, stations] = await Promise.all([
    fetch("/api/config").then((r) => r.json()),
    fetch("/api/models").then((r) => r.json()),
    fetch("/api/stations").then((r) => (r.ok ? r.json() : [])),
  ]);
  allStations = stations;

  document.getElementById("cfg-interval").value = cfg.fetchIntervalHours;
  document.getElementById("cfg-retention").value = cfg.retentionDays;
  document.getElementById("cfg-window").value = cfg.verifyWindowDays;

  const modelsEl = document.getElementById("cfg-models");
  modelsEl.innerHTML = "";
  const selectedModels = new Set(cfg.models || models.selected);
  models.available.forEach((m) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = m.id;
    cb.checked = selectedModels.has(m.id);
    const name = document.createElement("span");
    name.textContent = m.label;
    label.appendChild(cb);
    label.appendChild(name);
    modelsEl.appendChild(label);
  });

  selectedStationIdSet = new Set(cfg.vivaStationIds || []);
  renderStationChecklist("");
  document.getElementById("cfg-station-search").value = "";

  const unresolvedEl = document.getElementById("cfg-unresolved");
  if (cfg.unresolvedVivaStationIds && cfg.unresolvedVivaStationIds.length) {
    unresolvedEl.textContent =
      `Not found in the ViVa index — check the number: ${cfg.unresolvedVivaStationIds.join(", ")}`;
  } else {
    unresolvedEl.textContent = "";
  }

  document.getElementById("settings-dialog").showModal();
}

document.getElementById("settings-btn").addEventListener("click", () => {
  openSettings().catch((e) => console.error("failed to open settings:", e));
});

document.getElementById("cfg-station-search").addEventListener("input", (e) => {
  renderStationChecklist(e.target.value);
});

document.getElementById("settings-cancel").addEventListener("click", () => {
  document.getElementById("settings-dialog").close();
});

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("settings-error");
  errEl.textContent = "";

  const models = [...document.querySelectorAll("#cfg-models input:checked")].map((cb) => cb.value);
  const vivaStationIds = [...selectedStationIdSet];
  const fetchIntervalHours = Number(document.getElementById("cfg-interval").value);
  const retentionDays = Number(document.getElementById("cfg-retention").value);
  const verifyWindowDays = Number(document.getElementById("cfg-window").value);

  if (models.length === 0) {
    errEl.textContent = "Select at least one weather model.";
    return;
  }

  const saveBtn = document.getElementById("settings-save");
  saveBtn.disabled = true;
  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models, vivaStationIds, fetchIntervalHours, retentionDays, verifyWindowDays }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "save failed");

    const unresolvedEl = document.getElementById("cfg-unresolved");
    if (body.unresolvedVivaStationIds && body.unresolvedVivaStationIds.length) {
      unresolvedEl.textContent =
        `Not found in the ViVa index — check the number: ${body.unresolvedVivaStationIds.join(", ")}`;
      return; // let the user see the warning before closing
    }
    document.getElementById("settings-dialog").close();
    refresh();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById("location-select").addEventListener("change", (e) => {
  currentLocation = e.target.value;
  render();
});
document.getElementById("metric-select").addEventListener("change", (e) => {
  currentMetric = e.target.value;
  renderDetail();
});

refresh();
setInterval(refresh, 5 * 60 * 1000);
