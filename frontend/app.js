// Plain-JS line drawing UI on top of KLineCharts (loaded via CDN in index.html).
// Talks to the Cloudflare Worker API (GET/POST /lines, DELETE /lines/{id}, GET /candles).

const state = {
  chart: null,
  candles: [],
  drawMode: "none", // "none" | "horizontal" | "trend"
  pendingPoints: [], // collected {price, timestamp} while drawing a trend line
  overlayIdByLineId: new Map(),
};

const el = {
  apiBase: document.getElementById("apiBase"),
  symbol: document.getElementById("symbol"),
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

async function loadCandles() {
  const data = await api(`/candles?symbol=${encodeURIComponent(symbol())}&limit=300`);
  state.candles = data;
  state.chart.setDataLoader({
    getBars: ({ callback }) => callback(state.candles),
  });
  state.chart.setSymbol({ ticker: symbol() });
  state.chart.setPeriod({ type: "minute", span: 1 });
  state.chart.resetData();
}

function renderOverlayForLine(line) {
  const existingId = state.overlayIdByLineId.get(line.id);
  if (existingId) {
    state.chart.removeOverlay({ id: existingId });
  }

  let overlayId;
  if (line.kind === "horizontal") {
    overlayId = state.chart.createOverlay({
      name: "horizontalStraightLine",
      points: [{ value: line.points[0].price }],
    });
  } else {
    overlayId = state.chart.createOverlay({
      name: "straightLine",
      points: line.points.map((p) => ({ timestamp: p.timestamp, value: p.price })),
    });
  }
  state.overlayIdByLineId.set(line.id, overlayId);
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

  for (const id of state.overlayIdByLineId.values()) {
    state.chart.removeOverlay({ id });
  }
  state.overlayIdByLineId.clear();

  for (const line of lines) renderOverlayForLine(line);
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

function pixelToPricePoint(clientX, clientY) {
  const rect = el.chart.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const point = state.chart.convertFromPixel([{ x, y }])[0];
  if (typeof point?.value !== "number") return null;
  const timestamp = point.timestamp ?? Date.now();
  return { price: point.value, timestamp };
}

async function onChartClick(event) {
  if (state.drawMode === "none") return;

  const point = pixelToPricePoint(event.clientX, event.clientY);
  if (!point) return;

  if (state.drawMode === "horizontal") {
    await createLine("horizontal", [point]);
    setMode("none");
    return;
  }

  // trend
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
  for (const btn of el.modeButtons) {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  }
  el.chart.addEventListener("click", onChartClick);
}

async function refreshAll() {
  await loadCandles();
  await loadLines();
}

function init() {
  state.chart = klinecharts.init("chart");
  wireControls();
  setMode("none");
  refreshAll().catch((err) => {
    console.error(err);
    el.drawHint.textContent = `読み込みエラー: ${err.message}`;
  });
}

init();
