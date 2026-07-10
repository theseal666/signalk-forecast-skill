let scoreboard = null;
let currentLocation = null;
let currentMetric = "score";

// For error metrics lower is better; for skill higher is better. The bar
// color goes green→red accordingly, scaled against the worst value on show.
const METRIC_META = {
    score:        { unit: "%", lowerBetter: false, digits: 0, scale: 100 },
    dirMAE_deg:   { unit: "°", lowerBetter: true, digits: 1 },
    dirBias_deg:  { unit: "°", lowerBetter: true, signed: true, digits: 1 },
    skill:        { unit: "", lowerBetter: false, digits: 2 },
    speedMAE_ms:  { unit: " m/s", lowerBetter: true, digits: 1 },
    vectorRMSE_ms: { unit: " m/s", lowerBetter: true, digits: 1 },
};

function fetchScoreboard() {
    return fetch("/plugins/forecast-skill/scoreboard")
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
}

function locationEntry() {
    if (!scoreboard) return null;
    return scoreboard.locations.find(l => l.label === currentLocation) || null;
}

function modelLabel(id) {
    return (scoreboard && scoreboard.modelLabels && scoreboard.modelLabels[id]) || id;
}

function haversineNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Green (good) to red (bad) across a 0..1 badness ratio
function colorFor(badness) {
    const hue = (1 - Math.max(0, Math.min(1, badness))) * 120; // 120=green, 0=red
    return `hsl(${hue}, 65%, 45%)`;
}

function formatValue(v, meta) {
    if (v == null) return "–";
    const display = (meta.scale != null ? v * meta.scale : v);
    const s = display.toFixed(meta.digits);
    return (meta.signed && display > 0 ? "+" : "") + s + meta.unit;
}

// Build one bar-line div (shared by composite panel and per-bucket chart)
function makeBarLine(labelText, value, barWidthPct, color, valueText, note) {
    const line = document.createElement("div");
    line.className = "bar-line";

    const name = document.createElement("div");
    name.className = "model-name";
    name.textContent = labelText;

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = Math.max(2, barWidthPct) + "%";
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

function renderComposite() {
    const panel = document.getElementById("composite-bars");
    panel.innerHTML = "";

    const loc = locationEntry();
    if (!scoreboard || !loc) return;

    const models = loc.models
        .filter(m => m.composite != null)
        .sort((a, b) => b.composite - a.composite);

    if (models.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "not enough change events yet — needs a few days of data";
        panel.appendChild(empty);
        return;
    }

    models.forEach(m => {
        const pct = Math.round(m.composite * 100);
        panel.appendChild(makeBarLine(
            modelLabel(m.model),
            m.composite,
            pct,
            colorFor(1 - m.composite),
            `<strong>${pct}%</strong>`,
            null
        ));
    });
}

function render() {
    const chart = document.getElementById("chart");
    const hint = document.getElementById("hint");
    chart.innerHTML = "";

    renderComposite();

    const loc = locationEntry();
    if (!scoreboard || !loc) {
        hint.textContent = "Waiting for scoreboard data…";
        return;
    }
    hint.textContent = "";

    const meta = METRIC_META[currentMetric];
    document.getElementById("metric-label").textContent =
        " — " + document.getElementById("metric-select").selectedOptions[0].text;

    scoreboard.buckets.forEach((bucket, bi) => {
        // gather this bucket's value for every model
        const rows = loc.models
            .map(m => ({ model: m.model, cell: m.buckets[bi], composite: m.composite }))
            .filter(r => r.cell && r.cell.n > 0 && r.cell[currentMetric] != null);

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
            // scale bars against the largest magnitude in this bucket
            const maxMag = Math.max(...rows.map(r => Math.abs(r.cell[currentMetric]))) || 1;
            rows.forEach(r => {
                const v = r.cell[currentMetric];
                const mag = Math.abs(v);
                let badness;
                if (meta.lowerBetter) badness = mag / maxMag;
                else badness = 1 - Math.max(0, Math.min(1, v));

                // Add composite badge next to model name so ranking is
                // always visible regardless of which metric is selected
                const composite = r.composite != null
                    ? ` <span class="composite-badge">${Math.round(r.composite * 100)}%</span>`
                    : "";

                bars.appendChild(makeBarLine(
                    modelLabel(r.model),
                    v,
                    (mag / maxMag) * 100,
                    colorFor(badness),
                    formatValue(v, meta) + composite,
                    `n=${r.cell.n}`
                ));
            });
        }

        row.appendChild(bars);
        chart.appendChild(row);
    });
}

function populateLocations() {
    const sel = document.getElementById("location-select");
    sel.innerHTML = "";
    if (!scoreboard || scoreboard.locations.length === 0) {
        const opt = document.createElement("option");
        opt.text = "no locations yet";
        sel.appendChild(opt);
        return;
    }

    const bp = scoreboard.boatPosition;
    const locs = scoreboard.locations.map(l => {
        const distNm = (bp && l.latitude != null)
            ? haversineNm(bp.lat, bp.lon, l.latitude, l.longitude)
            : null;
        return { ...l, distNm };
    });

    if (bp) locs.sort((a, b) => (a.distNm ?? Infinity) - (b.distNm ?? Infinity));

    locs.forEach(l => {
        const opt = document.createElement("option");
        opt.value = l.label;
        const dist = l.distNm != null ? ` — ${l.distNm.toFixed(0)} nm` : "";
        opt.text = l.label + dist;
        sel.appendChild(opt);
    });

    if (!locs.some(l => l.label === currentLocation)) {
        currentLocation = locs[0].label;
    }
    sel.value = currentLocation;
}

function refresh() {
    return fetchScoreboard().then(sb => {
        if (!sb || !sb.locations) return;
        scoreboard = sb;
        populateLocations();
        document.getElementById("metric-select").value = currentMetric;
        document.getElementById("window-info").textContent =
            `verification window: ${sb.windowDays} days · updated ${new Date(sb.generatedAt).toLocaleTimeString()}`;
        render();
    });
}

document.getElementById("location-select").addEventListener("change", e => {
    currentLocation = e.target.value;
    render();
});
document.getElementById("metric-select").addEventListener("change", e => {
    currentMetric = e.target.value;
    render();
});

refresh();
setInterval(refresh, 5 * 60 * 1000);
