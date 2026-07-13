// Forecast Skill webapp — built to answer three questions:
//   1. What forecast has been the best match at this station?  (#ranking)
//   2. Which should I choose?                                  (#reco)
//   3. Is there a reason to switch model by horizon?           (#horizon)
// Everything else (per lead-time metrics) lives in the collapsible detail panel.

let scoreboard = null;
let currentLocation = null;
let currentMetric = "score";

// Lead-time groupings a sailor actually thinks in.
const RACE_BUCKETS = ["3h", "6h", "12h", "24h"]; // ranking + summary window
const HORIZONS = [
  { id: "now", label: "Now → 3 h", ids: ["1h", "2h", "3h"] },
  { id: "morning", label: "6 → 12 h", ids: ["6h", "12h"] },
  { id: "before", label: "24 h → 2 d", ids: ["24h", "2d"] },
];

const METRIC_META = {
  score:        { unit: "%", lowerBetter: false, digits: 0, scale: 100 },
  dirMAE_deg:   { unit: "°", lowerBetter: true, digits: 1 },
  dirBias_deg:  { unit: "°", lowerBetter: true, signed: true, digits: 1 },
  skill:        { unit: "", lowerBetter: false, digits: 2, diverging: true, halfScale: 1.0 },
  speedMAE_ms:  { unit: " m/s", lowerBetter: true, digits: 1 },
  vectorRMSE_ms: { unit: " m/s", lowerBetter: true, digits: 1 },
};

function fetchScoreboard() {
  return fetch("/plugins/forecast-skill/scoreboard")
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
        `<span title="Of the ${s.obsEvents} tactically real wind shifts (≥20°, hourly-smoothed) observed this week, how many the model predicted within 3 h.">catches ${s.hits}/${s.obsEvents} shifts</span>`
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

function render() {
  const loc = locationEntry();
  if (!scoreboard || !loc) return;
  const summaries = loc.models.map(summarize);
  renderReco(loc, summaries);
  renderRanking(loc, summaries);
  renderHorizon(loc);
  renderDetail();
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
      `${sb.windowDays}-day window · updated ${new Date(sb.generatedAt).toLocaleTimeString()}`;
    render();
  });
}

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
