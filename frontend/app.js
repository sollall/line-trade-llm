// Plain-JS line drawing UI on top of TradingView Lightweight Charts (loaded via CDN in index.html).
// Talks to the Cloudflare Worker API (GET/POST /lines, DELETE /lines/{id}, GET /candles).

const state = {
  chart: null,
  series: null,
  trendLines: null, // TrendLinesPrimitive
  candles: [], // ascending by timestamp; older pages get prepended while scrolling left
  loadGeneration: 0, // bumped on symbol/timeframe reload so stale responses are dropped
  loadingOlder: false,
  historyExhausted: false, // the exchange returned nothing older
  drawMode: "none", // "none" | "horizontal" | "trend"
  pendingPoints: [], // collected {price, timestamp} while drawing a trend line
  priceLines: [], // IPriceLine handles for horizontal lines
  savedTrendLines: [], // trend lines from the API, redrawn together with the drawing preview
};

const LINE_COLOR = "#f0b429";
const CANDLES_PER_PAGE = 1000;
// Start fetching older candles when the view gets within this many bars of the oldest loaded one.
const LOAD_OLDER_THRESHOLD_BARS = 50;

const el = {
  apiBase: document.getElementById("apiBase"),
  symbol: document.getElementById("symbol"),
  interval: document.getElementById("interval"),
  reload: document.getElementById("reload"),
  chart: document.getElementById("chart"),
  drawHint: document.getElementById("drawHint"),
  linesTableBody: document.querySelector("#linesTable tbody"),
  modeButtons: document.querySelectorAll(".draw-controls button[data-mode]"),
};

function apiBase() {
  return el.apiBase.value.replace(/\/$/, "");
}

function symbol() {
  return el.symbol.value.trim();
}

function intervalMinutes() {
  return Number(el.interval.value);
}

async function api(path, options) {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${path} failed: ${res.status} ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function setMode(mode) {
  state.drawMode = mode;
  state.pendingPoints = [];
  if (state.trendLines) renderTrendLines(state.savedTrendLines);
  for (const btn of el.modeButtons) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  el.drawHint.textContent =
    mode === "horizontal"
      ? "チャート上をクリックして水平線を配置してください"
      : mode === "trend"
        ? "チャート上を2回クリックしてトレンドラインを配置してください (1/2)"
        : "";
}

// --- time <-> logical index ---
// Lightweight Charts only resolves coordinates for times that exist in the data, but trend line
// points (and clicks on the empty area right of the last bar) can fall outside it. Map epoch-ms
// timestamps onto the bar index axis instead: interpolate between loaded candles (so gaps in the
// exchange data don't skew lines) and extrapolate by the timeframe outside them.

function barIntervalMs() {
  return intervalMinutes() * 60_000;
}

function timestampToLogical(timestamp) {
  const c = state.candles;
  if (c.length === 0) return null;
  const last = c.length - 1;
  if (timestamp <= c[0].timestamp) return (timestamp - c[0].timestamp) / barIntervalMs();
  if (timestamp >= c[last].timestamp) return last + (timestamp - c[last].timestamp) / barIntervalMs();

  // Binary search for c[lo].timestamp <= timestamp < c[lo + 1].timestamp.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid].timestamp <= timestamp) lo = mid;
    else hi = mid;
  }
  return lo + (timestamp - c[lo].timestamp) / (c[hi].timestamp - c[lo].timestamp);
}

// Only called with whole bar indices (clicks are snapped to a bar).
function logicalToTimestamp(logical) {
  const c = state.candles;
  if (c.length === 0) return null;
  const last = c.length - 1;
  if (logical < 0) return c[0].timestamp + logical * barIntervalMs();
  if (logical > last) return c[last].timestamp + (logical - last) * barIntervalMs();
  return c[logical].timestamp;
}

// --- trend line primitive ---
// Lightweight Charts has no drawing tools, so trend lines are drawn by a series primitive. Each line
// is extended across the whole pane in both directions, matching lineValueAt() in shared/src/touch.ts.

class TrendLinesPaneRenderer {
  constructor(segments) {
    this.segments = segments;
  }

  draw(target) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.lineWidth = 1.5;
      for (const seg of this.segments) {
        ctx.strokeStyle = seg.color;
        ctx.setLineDash(seg.dashed ? [6, 4] : []);
        const slope = (seg.y2 - seg.y1) / (seg.x2 - seg.x1);
        ctx.beginPath();
        ctx.moveTo(0, seg.y1 + slope * (0 - seg.x1));
        ctx.lineTo(mediaSize.width, seg.y1 + slope * (mediaSize.width - seg.x1));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = seg.color;
        for (const [x, y] of [[seg.x1, seg.y1], [seg.x2, seg.y2]]) {
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }
}

// timeScale.logicalToCoordinate() returns 0 for fractional indices, so interpolate between the
// neighbouring whole bars ourselves (points between bars are common after changing timeframe).
function logicalToX(timeScale, logical) {
  const base = Math.floor(logical);
  const x0 = timeScale.logicalToCoordinate(base);
  const x1 = timeScale.logicalToCoordinate(base + 1);
  if (x0 === null || x1 === null) return null;
  return x0 + (logical - base) * (x1 - x0);
}

class TrendLinesPaneView {
  constructor(source) {
    this.source = source;
    this.segments = [];
  }

  update() {
    const { chart, series } = this.source;
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    const toXY = (p) => {
      const logical = timestampToLogical(p.timestamp);
      if (logical === null) return null;
      const x = logicalToX(timeScale, logical);
      const y = series.priceToCoordinate(p.price);
      return x === null || y === null ? null : [x, y];
    };

    this.segments = [];
    for (const line of this.source.lines) {
      const a = toXY(line.points[0]);
      const b = toXY(line.points[1]);
      if (!a || !b || a[0] === b[0]) continue;
      this.segments.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], color: line.color, dashed: line.dashed });
    }
  }

  renderer() {
    return new TrendLinesPaneRenderer(this.segments);
  }
}

class TrendLinesPrimitive {
  constructor() {
    this.lines = []; // { points: [{price, timestamp}, {price, timestamp}], color, dashed }
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
    this.views = [new TrendLinesPaneView(this)];
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setLines(lines) {
    this.lines = lines;
    this.requestUpdate?.();
  }

  updateAllViews() {
    for (const view of this.views) view.update();
  }

  paneViews() {
    return this.views;
  }
}

function fetchCandles(endTime) {
  const params = new URLSearchParams({
    symbol: symbol(),
    interval: String(intervalMinutes()),
    limit: String(CANDLES_PER_PAGE),
  });
  if (endTime !== undefined) params.set("endTime", String(endTime));
  return api(`/candles?${params}`);
}

function setSeriesData() {
  state.series.setData(
    state.candles.map((c) => ({
      time: Math.floor(c.timestamp / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  );
}

async function loadCandles() {
  const generation = ++state.loadGeneration;
  state.loadingOlder = false;
  state.historyExhausted = false;
  const data = await fetchCandles();
  if (generation !== state.loadGeneration) return;
  state.candles = data;
  // Until the range is reset below, the previous scroll position (possibly at the left edge) still
  // applies to the new data and would trigger an unwanted older-page load.
  state.loadingOlder = true;
  setSeriesData();
  // Show roughly the latest 150 bars; older ones are a scroll away (and more load on demand).
  const last = data.length - 1;
  state.chart.timeScale().setVisibleLogicalRange({ from: last - 150, to: last + 5 });
  requestAnimationFrame(() => {
    if (generation === state.loadGeneration) state.loadingOlder = false;
  });
}

async function loadOlderCandles() {
  if (state.loadingOlder || state.historyExhausted || state.candles.length === 0) return;
  const generation = state.loadGeneration;
  state.loadingOlder = true;
  try {
    const older = await fetchCandles(state.candles[0].timestamp);
    if (generation !== state.loadGeneration) return;
    const firstTimestamp = state.candles[0].timestamp;
    const fresh = older.filter((c) => c.timestamp < firstTimestamp);
    if (fresh.length === 0) {
      state.historyExhausted = true;
      return;
    }
    // Prepending shifts every logical index; setData keeps the view anchored to the right edge,
    // so the bars on screen stay put.
    state.candles = [...fresh, ...state.candles];
    setSeriesData();
  } finally {
    if (generation === state.loadGeneration) state.loadingOlder = false;
  }
}

function onVisibleLogicalRangeChange(range) {
  if (!range || range.from > LOAD_OLDER_THRESHOLD_BARS) return;
  loadOlderCandles().catch((err) => {
    console.error(err);
    el.drawHint.textContent = `過去データの読み込みエラー: ${err.message}`;
  });
}

function renderLinesOnChart(lines) {
  for (const priceLine of state.priceLines) state.series.removePriceLine(priceLine);
  state.priceLines = lines
    .filter((line) => line.kind === "horizontal")
    .map((line) =>
      state.series.createPriceLine({
        price: line.points[0].price,
        color: LINE_COLOR,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
      }),
    );
  renderTrendLines(lines.filter((line) => line.kind === "trend"));
}

function renderTrendLines(savedTrendLines, previewPoints = null) {
  state.savedTrendLines = savedTrendLines;
  const lines = savedTrendLines.map((line) => ({ points: line.points, color: LINE_COLOR, dashed: false }));
  if (previewPoints) lines.push({ points: previewPoints, color: "#4d76e8", dashed: true });
  state.trendLines.setLines(lines);
}

// While placing the 2nd point of a trend line, preview it from the 1st point to the cursor.
function onCrosshairMove(param) {
  if (state.drawMode !== "trend" || state.pendingPoints.length !== 1) return;
  const cursor = param.point ? coordinateToPricePoint(param.point.x, param.point.y) : null;
  const preview = cursor && cursor.timestamp !== state.pendingPoints[0].timestamp ? [state.pendingPoints[0], cursor] : null;
  renderTrendLines(state.savedTrendLines, preview);
}

function renderLinesTable(lines) {
  el.linesTableBody.innerHTML = "";
  for (const line of lines) {
    const tr = document.createElement("tr");

    const kindTd = document.createElement("td");
    kindTd.textContent = line.kind === "horizontal" ? "水平線" : "トレンドライン";
    tr.appendChild(kindTd);

    const symbolTd = document.createElement("td");
    symbolTd.textContent = line.symbol;
    tr.appendChild(symbolTd);

    const pointsTd = document.createElement("td");
    pointsTd.textContent = line.points.map((p) => p.price.toFixed(2)).join(" → ");
    tr.appendChild(pointsTd);

    const createdTd = document.createElement("td");
    createdTd.textContent = new Date(line.created_at).toLocaleString();
    tr.appendChild(createdTd);

    const actionsTd = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "削除";
    deleteBtn.addEventListener("click", () => deleteLine(line.id));
    actionsTd.appendChild(deleteBtn);
    tr.appendChild(actionsTd);

    el.linesTableBody.appendChild(tr);
  }
}

async function loadLines() {
  const lines = await api(`/lines?symbol=${encodeURIComponent(symbol())}`);
  renderLinesOnChart(lines);
  renderLinesTable(lines);
}

async function deleteLine(id) {
  await api(`/lines/${id}`, { method: "DELETE" });
  await loadLines();
}

async function createLine(kind, points) {
  await api("/lines", {
    method: "POST",
    body: JSON.stringify({ symbol: symbol(), kind, points }),
  });
  await loadLines();
}

// Chart pane coordinates -> {price, timestamp}; null outside the main pane (e.g. on the axes).
function coordinateToPricePoint(x, y) {
  const timeScale = state.chart.timeScale();
  if (x < 0 || y < 0 || x > timeScale.width() || y > state.chart.paneSize().height) return null;
  const logical = timeScale.coordinateToLogical(x);
  const price = state.series.coordinateToPrice(y);
  if (logical === null || price === null) return null;
  // Snap to the bar under the cursor so the stored timestamp is a candle open time.
  const timestamp = logicalToTimestamp(Math.round(logical));
  return timestamp === null ? null : { price, timestamp };
}

async function onChartClick(event) {
  if (state.drawMode === "none") return;

  const rect = el.chart.getBoundingClientRect();
  const point = coordinateToPricePoint(event.clientX - rect.left, event.clientY - rect.top);
  if (!point) return;

  if (state.drawMode === "horizontal") {
    await createLine("horizontal", [point]);
    setMode("none");
    return;
  }

  // trend
  if (state.pendingPoints.length === 1 && state.pendingPoints[0].timestamp === point.timestamp) {
    el.drawHint.textContent = "1点目と別の足をクリックしてください (2/2)";
    return;
  }
  state.pendingPoints.push(point);
  if (state.pendingPoints.length === 1) {
    el.drawHint.textContent = "チャート上を2回クリックしてトレンドラインを配置してください (2/2)";
    return;
  }
  await createLine("trend", state.pendingPoints);
  setMode("none");
}

function wireControls() {
  el.reload.addEventListener("click", refreshAll);
  el.interval.addEventListener("change", () => {
    setMode("none");
    loadCandles().catch((err) => {
      console.error(err);
      el.drawHint.textContent = `読み込みエラー: ${err.message}`;
    });
  });
  state.chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleLogicalRangeChange);
  for (const btn of el.modeButtons) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }
  state.chart.subscribeCrosshairMove(onCrosshairMove);
  // Native DOM clicks rather than chart.subscribeClick: Lightweight Charts swallows a click that
  // lands within 500ms of the previous one (its double-click detection), which would drop quickly
  // placed points.
  let mouseDownAt = null;
  el.chart.addEventListener("mousedown", (event) => {
    mouseDownAt = { x: event.clientX, y: event.clientY };
  });
  el.chart.addEventListener("click", (event) => {
    // Ignore the click that ends a pan/zoom drag.
    const dragged =
      mouseDownAt && Math.abs(event.clientX - mouseDownAt.x) + Math.abs(event.clientY - mouseDownAt.y) >= 5;
    mouseDownAt = null;
    if (dragged) return;
    onChartClick(event).catch((err) => {
      console.error(err);
      el.drawHint.textContent = `保存エラー: ${err.message}`;
    });
  });
}

async function refreshAll() {
  await loadCandles();
  await loadLines();
}

// Chart times are UTC epoch seconds; label them in the browser's local time. tickMarkType is
// LightweightCharts.TickMarkType: 0 Year, 1 Month, 2 DayOfMonth, 3 Time, 4 TimeWithSeconds.
function tickMarkFormatter(time, tickMarkType) {
  const d = new Date(time * 1000);
  switch (tickMarkType) {
    case 0:
      return String(d.getFullYear());
    case 1:
      return `${d.getFullYear()}/${d.getMonth() + 1}`;
    case 2:
      return `${d.getMonth() + 1}/${d.getDate()}`;
    default:
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}

function init() {
  const { createChart, CandlestickSeries, CrosshairMode } = LightweightCharts;
  state.chart = createChart(el.chart, {
    autoSize: true,
    layout: { background: { color: "#0f1115" }, textColor: "#9aa3b2" },
    grid: { vertLines: { color: "#1f232b" }, horzLines: { color: "#1f232b" } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#2a2e37" },
    timeScale: {
      borderColor: "#2a2e37",
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter,
    },
    localization: { timeFormatter: (time) => new Date(time * 1000).toLocaleString() },
  });
  state.series = state.chart.addSeries(CandlestickSeries, {
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderVisible: false,
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });
  state.trendLines = new TrendLinesPrimitive();
  state.series.attachPrimitive(state.trendLines);
  wireControls();
  setMode("none");
  refreshAll().catch((err) => {
    console.error(err);
    el.drawHint.textContent = `読み込みエラー: ${err.message}`;
  });
}

init();
