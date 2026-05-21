const SUN_YAT_SEN_UNIVERSITY_CENTER = [23.0964, 113.2988];
const DEFAULT_MAP_ZOOM = 16;

const map = L.map("map").setView(
  SUN_YAT_SEN_UNIVERSITY_CENTER,
  DEFAULT_MAP_ZOOM
);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// --- 状态 ---
let routePoints = [];          // {lat, lng}[]
let pointMarkers = [];         // Leaflet CircleMarker[]
let polyline = null;
let paceChart = null;
let hrChart = null;
let previewData = null;
let previewTimer = null;
let previewIndex = 0;
let previewMarker = null;

// --- 工具函数 ---
function updateMessage(text, isError = false) {
  const el = document.getElementById("message");
  el.textContent = text || "";
  el.className = "message" + (isError ? " error" : "");
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeDistanceMeters(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat, points[i].lng
    );
  }
  return total;
}

function dateToLocalInputValue(d) {
  const tzOffset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tzOffset * 60000);
  return local.toISOString().slice(0, 16);
}

// --- 距离 & 目标进度 ---
function updateDistanceInfo() {
  const el = document.getElementById("distanceInfo");
  const progressFill = document.getElementById("progressFill");
  const targetPercent = document.getElementById("targetPercent");
  const targetInput = document.getElementById("targetDistance");

  if (!el) return;

  if (!routePoints || routePoints.length < 2) {
    el.textContent = "总距离约：0 公里";
    if (progressFill) progressFill.style.width = "0%";
    if (targetPercent) targetPercent.textContent = "";
    return;
  }

  const baseMeters = computeDistanceMeters(routePoints);
  const baseKm = baseMeters / 1000;
  const lapInput = document.getElementById("lapCount");
  const laps = Math.max(1, parseInt(lapInput?.value, 10) || 1);
  const totalKm = baseKm * laps;
  const baseStr = baseKm.toFixed(2);
  const totalStr = totalKm.toFixed(2);

  if (laps > 1) {
    el.textContent = `总距离约：${totalStr} 公里（基础：${baseStr} 公里 × ${laps} 圈）`;
  } else {
    el.textContent = `总距离约：${totalStr} 公里`;
  }

  // 目标距离进度
  const target = parseFloat(targetInput?.value) || 0;
  if (target > 0 && progressFill && targetPercent) {
    const pct = Math.min(100, (totalKm / target) * 100);
    progressFill.style.width = pct + "%";
    progressFill.style.background = pct >= 100 ? "#22c55e" : pct >= 80 ? "#f59e0b" : "#3b82f6";
    targetPercent.textContent = pct >= 100 ? "✓ 已达标" : `${pct.toFixed(0)}%`;
    targetPercent.style.color = pct >= 100 ? "#22c55e" : "#666";
  } else if (progressFill) {
    progressFill.style.width = "0%";
  }
  if (target <= 0 && targetPercent) {
    targetPercent.textContent = "";
  }
}

// --- 轨迹点管理（含标记） ---
function addPointMarker(lat, lng, index) {
  const marker = L.circleMarker([lat, lng], {
    radius: 5,
    color: "#ff5722",
    fillColor: "#ff5722",
    fillOpacity: 0.6,
    weight: 2
  }).addTo(map);

  marker._pointIndex = index;
  marker.bindTooltip(String(index + 1), { permanent: false, direction: "top" });

  marker.on("contextmenu", (e) => {
    L.DomEvent.preventDefault(e.originalEvent);
    deletePointAt(marker._pointIndex);
  });

  pointMarkers.push(marker);
  // 更新所有标记的 index（因为可能有插入/删除）
  refreshMarkerIndices();
}

function refreshMarkerIndices() {
  pointMarkers.forEach((m, i) => {
    m._pointIndex = i;
    m.setTooltipContent(String(i + 1));
  });
}

function deletePointAt(index) {
  if (index < 0 || index >= routePoints.length) return;
  routePoints.splice(index, 1);
  const marker = pointMarkers.splice(index, 1)[0];
  if (marker) map.removeLayer(marker);
  refreshMarkerIndices();
  redrawPolyline();
  updateMessage(`已删除第 ${index + 1} 个点，剩余 ${routePoints.length} 个`);
  updateDistanceInfo();
}

function undoLastPoint() {
  if (routePoints.length === 0) return;
  const idx = routePoints.length - 1;
  routePoints.pop();
  const marker = pointMarkers.pop();
  if (marker) map.removeLayer(marker);
  refreshMarkerIndices();
  redrawPolyline();
  updateMessage(`已撤销，剩余 ${routePoints.length} 个点`);
  updateDistanceInfo();
}

function redrawPolyline() {
  if (polyline) map.removeLayer(polyline);
  if (routePoints.length >= 2) {
    polyline = L.polyline(routePoints, { color: "#ff5722" }).addTo(map);
  } else {
    polyline = null;
  }
}

function clearAllPoints() {
  routePoints = [];
  pointMarkers.forEach(m => map.removeLayer(m));
  pointMarkers = [];
  if (polyline) {
    map.removeLayer(polyline);
    polyline = null;
  }
  updateMessage("轨迹已清除");
  updateDistanceInfo();
}

// --- 地图交互 ---
map.on("click", (e) => {
  routePoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
  addPointMarker(e.latlng.lat, e.latlng.lng, routePoints.length - 1);
  if (polyline) {
    polyline.setLatLngs(routePoints);
  } else if (routePoints.length >= 2) {
    polyline = L.polyline(routePoints, { color: "#ff5722" }).addTo(map);
  }
  updateMessage(`已添加点数：${routePoints.length}`);
  updateDistanceInfo();
});

// 键盘快捷键
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    undoLastPoint();
  }
  if (e.key === "Delete" && document.activeElement === document.body) {
    e.preventDefault();
    clearAllPoints();
  }
});

// --- 按钮事件 ---
document.getElementById("clearRoute").addEventListener("click", clearAllPoints);
document.getElementById("undoBtn").addEventListener("click", undoLastPoint);

// --- 目标距离变动 ---
const targetInput = document.getElementById("targetDistance");
if (targetInput) {
  targetInput.addEventListener("input", updateDistanceInfo);
}

// --- 地图搜索 ---
let searchTimer = null;
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");

if (searchInput) {
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) {
      searchResults.innerHTML = "";
      searchResults.style.display = "none";
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 400);
  });

  searchInput.addEventListener("focus", () => {
    if (searchResults.children.length > 0) {
      searchResults.style.display = "block";
    }
  });

  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.style.display = "none";
    }
  });
}

async function doSearch(query) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`,
      { headers: { "Accept-Language": "zh" } }
    );
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      searchResults.innerHTML = '<div class="search-item no-result">未找到结果</div>';
      searchResults.style.display = "block";
      return;
    }
    searchResults.innerHTML = data.map((r, i) =>
      `<div class="search-item" data-lat="${r.lat}" data-lng="${r.lon}" data-idx="${i}">
        <strong>${escapeHtml(r.display_name.split(",").slice(0, 3).join(" · "))}</strong>
        <small>${escapeHtml(r.display_name)}</small>
      </div>`
    ).join("");
    searchResults.style.display = "block";

    searchResults.querySelectorAll(".search-item").forEach(item => {
      item.addEventListener("click", () => {
        const lat = parseFloat(item.dataset.lat);
        const lng = parseFloat(item.dataset.lng);
        map.flyTo([lat, lng], 17);
        searchResults.style.display = "none";
        searchInput.value = item.querySelector("strong").textContent;
        updateMessage(`已定位到：${item.querySelector("strong").textContent}`);
      });
    });
  } catch (e) {
    console.error("search error", e);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- 导出份数 × 时间/配速列表 ---
function rebuildExportTimes() {
  const container = document.getElementById("exportTimes");
  const exportInput = document.getElementById("exportCount");
  if (!container || !exportInput) return;

  const count = Math.max(1, Math.min(10, parseInt(exportInput.value, 10) || 1));
  const now = new Date();

  container.innerHTML = "";

  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.className = "export-time-row";

    const label = document.createElement("span");
    label.textContent = `第 ${i + 1} 份`;

    const timeInput = document.createElement("input");
    timeInput.type = "datetime-local";
    timeInput.className = "export-time-input";
    timeInput.dataset.index = String(i);
    const d = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    timeInput.value = dateToLocalInputValue(d);

    // 合并配速输入：分钟.秒
    const paceInput = document.createElement("input");
    paceInput.type = "text";
    paceInput.className = "export-pace";
    paceInput.placeholder = "6'00\"";
    paceInput.value = "6'00\"";
    paceInput.dataset.index = String(i);
    paceInput.addEventListener("input", () => {
      // 格式化辅助
      paceInput.value = paceInput.value.replace(/[^0-9'"]/g, "");
    });

    row.appendChild(label);
    row.appendChild(timeInput);
    row.appendChild(paceInput);
    container.appendChild(row);
  }

  bindPacePresets();
}

// 解析配速字符串 "6'00\"" → 秒数
function parsePaceString(str) {
  if (!str) return NaN;
  const match = str.match(/(\d+)'(\d+)"/);
  if (match) {
    return parseInt(match[1]) * 60 + parseInt(match[2]);
  }
  const num = parseFloat(str);
  if (!isNaN(num)) return num * 60; // 纯数字视为分钟
  return NaN;
}

function bindPacePresets() {
  const presets = document.querySelectorAll(".preset-btn");
  presets.forEach(btn => {
    btn.addEventListener("click", () => {
      const sec = parseInt(btn.dataset.pace);
      const min = Math.floor(sec / 60);
      const s = sec % 60;
      const text = `${min}'${s.toString().padStart(2, "0")}"`;
      // 填到当前所有的配速输入框
      const paceInputs = document.querySelectorAll(".export-pace");
      paceInputs.forEach(inp => { inp.value = text; });
      updateMessage(`已设置所有配速为 ${text}`);
    });
  });
}

// --- 生成 FIT（批量 ZIP） ---
async function generateFit() {
  if (routePoints.length < 2) {
    updateMessage("请至少在地图上选择两个点形成轨迹", true);
    return;
  }

  const hrRest = parseInt(document.getElementById("hrRest").value, 10) || 60;
  const hrMax = parseInt(document.getElementById("hrMax").value, 10) || 180;

  const lapInput = document.getElementById("lapCount");
  const exportInput = document.getElementById("exportCount");
  const lapCount = Math.max(1, parseInt(lapInput?.value, 10) || 1);
  const exportCount = Math.max(1, Math.min(10, parseInt(exportInput?.value, 10) || 1));

  const exportTimesContainer = document.getElementById("exportTimes");
  const timeInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-time-input"))
    : [];
  const paceInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-pace"))
    : [];

  if (timeInputs.length < exportCount || paceInputs.length < exportCount) {
    updateMessage("导出份数与时间/配速行数不一致", true);
    return;
  }

  // 收集所有导出配置
  const exportList = [];
  for (let i = 0; i < exportCount; i++) {
    const timeInput = timeInputs[i];
    if (!timeInput || !timeInput.value) {
      updateMessage(`请为第 ${i + 1} 份设置开始日期时间`, true);
      return;
    }
    const fileStart = new Date(timeInput.value);
    if (Number.isNaN(fileStart.getTime())) {
      updateMessage(`第 ${i + 1} 份的开始时间无效`, true);
      return;
    }

    const paceStr = paceInputs[i]?.value || "6'00\"";
    const paceSeconds = parsePaceString(paceStr);
    if (!paceSeconds || paceSeconds <= 0) {
      updateMessage(`第 ${i + 1} 份的配速无效（格式：6'00"）`, true);
      return;
    }

    exportList.push({
      startTime: fileStart.toISOString(),
      points: routePoints,
      paceSecondsPerKm: paceSeconds
    });
  }

  // 进度条
  const progressContainer = document.getElementById("progressContainer");
  const progressFill = document.getElementById("genProgressFill");
  const progressText = document.getElementById("genProgressText");
  if (progressContainer) progressContainer.style.display = "block";
  if (progressFill) progressFill.style.width = "0%";

  // 批量生成（服务端打包 ZIP，单份也走这个接口统一逻辑）
  try {
    updateMessage(`正在生成 ${exportCount} 个 FIT 文件，请稍候...`);
    if (progressText) progressText.textContent = "0/" + exportCount;

    const res = await fetch("/api/generate-fit-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        exports: exportList,
        hrRest,
        hrMax,
        lapCount
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      updateMessage(err.error || "生成失败", true);
      if (progressContainer) progressContainer.style.display = "none";
      return;
    }

    // 模拟进度
    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += 5;
      if (progress > 90) { clearInterval(progressInterval); return; }
      if (progressFill) progressFill.style.width = progress + "%";
      if (progressText) progressText.textContent = `${Math.min(exportCount, Math.ceil(progress / 100 * exportCount))}/${exportCount}`;
    }, 100);

    const blob = await res.blob();
    clearInterval(progressInterval);

    if (progressFill) progressFill.style.width = "100%";
    if (progressText) progressText.textContent = `${exportCount}/${exportCount}`;

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportCount > 1
      ? `fit_exports_${exportCount}files.zip`
      : "run.fit";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    updateMessage(`已生成 ${exportCount} 个 FIT 文件` + (exportCount > 1 ? "（打包为 ZIP）" : ""));

    setTimeout(() => {
      if (progressContainer) progressContainer.style.display = "none";
    }, 2000);
  } catch (e) {
    console.error(e);
    updateMessage("请求失败，请稍后重试", true);
    if (progressContainer) progressContainer.style.display = "none";
  }
}

document.getElementById("generateFit").addEventListener("click", generateFit);

// --- 圈数/导出份数联动 ---
const lapInputInit = document.getElementById("lapCount");
if (lapInputInit) {
  lapInputInit.addEventListener("input", updateDistanceInfo);
}
const exportInputInit = document.getElementById("exportCount");
if (exportInputInit) {
  exportInputInit.addEventListener("input", rebuildExportTimes);
}
updateDistanceInfo();
rebuildExportTimes();

// --- 预览图表 ---
function renderPreviewCharts(preview) {
  if (!preview || !Array.isArray(preview.samples) || preview.samples.length === 0) {
    updateMessage("预览数据为空", true);
    return;
  }

  const labels = preview.samples.map((s) => (s.timeSec / 60).toFixed(1));
  const paceData = preview.samples.map((s) => {
    const speed = s.speed > 0 ? s.speed : 0.01;
    const secPerKm = 1000 / speed;
    return secPerKm / 60;
  });
  const hrData = preview.samples.map((s) => s.heartRate);

  const paceCtx = document.getElementById("paceChart").getContext("2d");
  const hrCtx = document.getElementById("hrChart").getContext("2d");

  if (paceChart) paceChart.destroy();
  if (hrChart) hrChart.destroy();

  paceChart = new Chart(paceCtx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "配速 (min/km)",
        data: paceData,
        borderColor: "#1976d2",
        tension: 0.2,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "时间 (分钟)" } },
        y: { title: { display: true, text: "min/km" }, reverse: true }
      }
    }
  });

  hrChart = new Chart(hrCtx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: "心率 (bpm)",
        data: hrData,
        borderColor: "#e53935",
        tension: 0.2,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "时间 (分钟)" } },
        y: { title: { display: true, text: "bpm" } }
      }
    }
  });
}

async function previewActivity() {
  if (routePoints.length < 2) {
    updateMessage("请至少在地图上选择两个点形成轨迹", true);
    return;
  }

  const exportTimesContainer = document.getElementById("exportTimes");
  const timeInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-time-input"))
    : [];
  const paceInputs = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-pace"))
    : [];

  if (!timeInputs.length || !paceInputs.length) {
    updateMessage("请先在导出列表中设置至少一份的时间和配速", true);
    return;
  }

  const firstTimeInput = timeInputs[0];
  if (!firstTimeInput.value) {
    const now = new Date();
    firstTimeInput.value = dateToLocalInputValue(now);
  }
  const start = new Date(firstTimeInput.value);
  if (Number.isNaN(start.getTime())) {
    updateMessage("预览使用的开始时间无效", true);
    return;
  }

  const paceStr = paceInputs[0]?.value || "6'00\"";
  const paceSecondsPerKm = parsePaceString(paceStr);
  if (!paceSecondsPerKm || paceSecondsPerKm <= 0) {
    updateMessage("预览使用的配速无效", true);
    return;
  }

  const hrRest = parseInt(document.getElementById("hrRest").value, 10) || 60;
  const hrMax = parseInt(document.getElementById("hrMax").value, 10) || 180;

  const lapInput = document.getElementById("lapCount");
  const lapCount = Math.max(1, parseInt(lapInput?.value, 10) || 1);

  updateMessage("正在生成预览，请稍候...");

  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startTime: start.toISOString(),
        points: routePoints,
        paceSecondsPerKm,
        hrRest,
        hrMax,
        lapCount
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      updateMessage(err.error || "预览失败", true);
      return;
    }

    const data = await res.json();
    renderPreviewCharts(data);

    const km = (data.totalDistanceMeters / 1000).toFixed(2);
    const min = (data.totalDurationSec / 60).toFixed(1);
    updateMessage(`预览已生成，总距离约 ${km} 公里，总时间约 ${min} 分钟`);
    previewData = data;
    previewIndex = 0;
    if (previewTimer) {
      clearInterval(previewTimer);
      previewTimer = null;
    }
    if (previewMarker) {
      map.removeLayer(previewMarker);
      previewMarker = null;
    }
    const samples = previewData.samples || [];
    if (samples.length > 0) {
      const first = samples[0];
      previewMarker = L.circleMarker([first.lat, first.lng], {
        radius: 6, color: "#1976d2"
      }).addTo(map);
      startPreviewPlayback();
    }
  } catch (e) {
    console.error(e);
    updateMessage("预览请求失败，请稍后重试", true);
  }
}

document.getElementById("previewBtn").addEventListener("click", previewActivity);

// --- 预览回放 ---
function updateLiveInfo(sample) {
  const el = document.getElementById("liveInfo");
  if (!el || !sample) return;
  const t = Math.max(0, sample.timeSec || 0);
  const min = Math.floor(t / 60);
  const sec = Math.floor(t % 60);
  const speed = sample.speed > 0 ? sample.speed : 0.01;
  const secPerKm = 1000 / speed;
  const paceMin = Math.floor(secPerKm / 60);
  const paceSec = Math.round(secPerKm % 60);
  const paceStr = `${paceMin}'${paceSec.toString().padStart(2, "0")}"/km`;
  const hr = sample.heartRate || 0;
  el.textContent = `时间 ${min}:${sec.toString().padStart(2, "0")}  配速 ${paceStr}  心率 ${hr} bpm`;
}

function startPreviewPlayback() {
  const samples = previewData?.samples || [];
  if (!samples.length) return;

  const totalSamples = samples.length;
  const stepMs = 100;
  previewIndex = 0;

  if (previewTimer) clearInterval(previewTimer);

  previewTimer = setInterval(() => {
    if (previewIndex >= totalSamples) {
      clearInterval(previewTimer);
      previewTimer = null;
      return;
    }
    const s = samples[previewIndex];
    if (previewMarker && s.lat != null && s.lng != null) {
      previewMarker.setLatLng([s.lat, s.lng]);
    }
    updateLiveInfo(s);
    previewIndex += 1;
  }, stepMs);
}
