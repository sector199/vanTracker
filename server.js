require("dotenv").config();
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CLAPPIA_CONFIG = {
  enabled: process.env.CLAPPIA_ENABLED === "true",
  apiKey: process.env.CLAPPIA_API_KEY,
  appId: process.env.CLAPPIA_APP_ID || "NQQ111672",
  workplaceId: process.env.CLAPPIA_WORKPLACE_ID || "GRE610440",
  userEmail: process.env.CLAPPIA_USER_EMAIL
};

const vans = {};
const getTodayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
let currentActiveDate = getTodayKey();

function checkMidnightReset() {
  const today = getTodayKey();
  if (today !== currentActiveDate) {
    console.log(`🌅 New day detected (${today}). Resetting daily van counters.`);
    for (const key of Object.keys(vans)) {
      delete vans[key];
    }
    currentActiveDate = today;
  }
}

// 1. MONGODB PERSISTENCE
let VanStateModel = null;
let isDbRestored = false;

if (process.env.MONGO_URI) {
  const vanSchema = new mongoose.Schema({
    dateKey: { type: String, unique: true },
    vansData: mongoose.Schema.Types.Mixed
  });
  VanStateModel = mongoose.model("VanDailyState", vanSchema);

  mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
      console.log("✅ Connected to MongoDB — Routes are restart-proof");
      await restoreStateFromDB();
    })
    .catch((err) => {
      console.error("MongoDB error:", err.message);
      isDbRestored = true;
    });
} else {
  isDbRestored = true;
}

async function restoreStateFromDB() {
  if (!VanStateModel) return;
  try {
    const doc = await VanStateModel.findOne({ dateKey: getTodayKey() });
    if (doc && doc.vansData) {
      Object.assign(vans, doc.vansData);
      console.log(`🔄 Restored ${Object.keys(vans).length} vans from MongoDB`);
    }
  } catch (e) {
    console.error("Restore error:", e.message);
  } finally {
    isDbRestored = true;
  }
}

let lastDbSave = 0;
async function backupStateToDB(force = false) {
  if (!VanStateModel || !isDbRestored) return;
  if (!force && Date.now() - lastDbSave < 60000) return;
  lastDbSave = Date.now();
  try {
    await VanStateModel.findOneAndUpdate(
      { dateKey: getTodayKey() },
      { vansData: vans },
      { upsert: true }
    );
  } catch (e) {
    console.error("Backup error:", e.message);
  }
}

// 2. KEEP-ALIVE ENDPOINT
app.get("/health", (req, res) => res.status(200).send("ALIVE"));

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    const hourIST = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    ).getHours();
    if (hourIST >= 8 && hourIST <= 21) {
      axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`).catch(() => {});
    }
  }, 10 * 60 * 1000);
}

function getDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 3. TRACCAR CLIENT RECEIVER
app.all(["/", "/traccar"], async (req, res) => {
  checkMidnightReset();

  const q = { ...req.query, ...req.body };
  const hasGpsParams = q.id || q.device_id || q.lat || q.location;

  if (req.method === "GET" && !hasGpsParams) {
    return res.send(getDashboardHtml());
  }

  try {
    const deviceId = String(q.device_id || q.id || "UNKNOWN-VAN").trim();
    const loc = q.location || {};
    const coords = loc.coords || {};
    const battObj = loc.battery || {};
    const isSos = q.alarm === "sos" || q.sos === "true" || q.sos === true;

    const lat = parseFloat(coords.latitude ?? q.lat);
    const lon = parseFloat(coords.longitude ?? q.lon);
    
    if (isNaN(lat) || isNaN(lon)) return res.status(200).send("OK");

    const speedKnotsOrMps = parseFloat(coords.speed ?? q.speed ?? 0);
    const speedKmh = Math.max(0, +(speedKnotsOrMps * 3.6).toFixed(1));
    const battery = battObj.level !== undefined ? Math.round(battObj.level * 100) : parseFloat(q.batt ?? 100);
    const isMock = Boolean(loc.mock === true || coords.mock === true || q.mock === "true" || q.mock === true);
    const now = Date.now();

    if (!vans[deviceId]) {
      vans[deviceId] = {
        deviceId, totalKm: 0, isMockDetected: false, sosAlert: false,
        battery: isNaN(battery) ? 100 : battery, lastSeen: now, idleSince: now,
        idleMinutes: 0, currentLat: lat, currentLon: lon, idleAnchorLat: lat,
        idleAnchorLon: lon, points: [], halts: []
      };
    }

    const van = vans[deviceId];
    if (isSos) van.sosAlert = true;

    const prevPoint = van.points[van.points.length - 1];

    if (prevPoint) {
      const distKm = getDistanceKm(prevPoint.lat, prevPoint.lon, lat, lon);
      if (distKm >= 0.015 && distKm < 5.0) {
        van.totalKm = +(van.totalKm + distKm).toFixed(2);
      }

      const distFromIdleAnchor = getDistanceKm(
        van.idleAnchorLat || prevPoint.lat, van.idleAnchorLon || prevPoint.lon, lat, lon
      );

      if (distFromIdleAnchor < 0.04) {
        van.idleMinutes = Math.round((now - van.idleSince) / 60000);
      } else {
        if (van.idleMinutes >= 10) {
          van.halts.push({
            lat: van.idleAnchorLat, lon: van.idleAnchorLon,
            durationMin: van.idleMinutes, endedAt: new Date(now).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
          });
        }
        van.idleSince = now; van.idleMinutes = 0; van.idleAnchorLat = lat; van.idleAnchorLon = lon;
      }
    }

    if (isMock) van.isMockDetected = true;
    if (!isNaN(battery)) van.battery = battery;
    van.lastSeen = now; van.currentLat = lat; van.currentLon = lon;

    van.points.push({ lat, lon, time: new Date(now).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }), speedKmh, battery: van.battery, isMock });

    await backupStateToDB(van.points.length === 1 || isSos); 
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Ping error:", err.message);
    return res.status(200).send("OK");
  }
});

// 4. API ENDPOINTS
app.get("/api/vans", (req, res) => {
  checkMidnightReset();
  res.json(vans);
});

app.get("/api/history/:date", async (req, res) => {
  if (!VanStateModel) return res.status(500).json({ error: "MongoDB not enabled" });
  try {
    const doc = await VanStateModel.findOne({ dateKey: req.params.date });
    res.json(doc ? doc.vansData : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/clear-sos/:deviceId", async (req, res) => {
  const van = vans[req.params.deviceId];
  if (van) {
    van.sosAlert = false;
    await backupStateToDB(true);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Van not found" });
  }
});

app.post("/api/push-to-clappia/:deviceId", async (req, res) => {
  const van = vans[req.params.deviceId];
  if (!van) return res.status(404).json({ error: "Van not found" });
  
  try {
    const response = await axios.post(
      "https://api-public-v4.clappia.com/submissions/create",
      {
        appId: CLAPPIA_CONFIG.appId, workplaceId: CLAPPIA_CONFIG.workplaceId, requestingUserEmailAddress: CLAPPIA_CONFIG.userEmail,
        data: { customer_n: `${van.deviceId} | ${van.totalKm} KM | Halts: ${van.halts.length} | Mock: ${van.isMockDetected ? "YES" : "NO"}`, phone_numb: `${van.currentLat.toFixed(5)},${van.currentLon.toFixed(5)}`, source: ["Babbler Disposition"] }
      },
      { headers: { "Content-Type": "application/json", "x-api-key": CLAPPIA_CONFIG.apiKey } }
    );
    res.json({ success: true, submissionId: response.data.submissionId });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Live Banner Van Anti-Cheat Tracker</title>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
    body { display: flex; height: 100vh; background: #0f172a; color: #f8fafc; overflow: hidden; position: relative; }
    #sidebar { width: 360px; padding: 16px; overflow-y: auto; border-right: 1px solid #1e293b; display: flex; flex-direction: column; gap: 14px; background: #0f172a; z-index: 1000; transition: transform 0.3s ease; }
    #map { flex: 1; height: 100%; z-index: 1; }
    body.sidebar-closed #sidebar { transform: translateX(-100%); position: absolute; height: 100%; }
    @media (max-width: 768px) { #sidebar { position: absolute; height: 100%; width: 100%; max-width: 320px; box-shadow: 4px 0 15px rgba(0,0,0,0.5); } body.sidebar-closed #sidebar { transform: translateX(-110%); } }
    .floating-controls { position: absolute; top: 12px; right: 12px; z-index: 999; display: flex; gap: 10px; }
    .float-btn { background: #1e293b; color: white; border: 2px solid #3b82f6; padding: 8px 12px; border-radius: 6px; cursor: pointer; font-weight: bold; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-size: 16px; }
    .menu-btn { position: absolute; top: 12px; left: 12px; z-index: 999; display: none; }
    body.sidebar-closed .menu-btn { display: block; }
    .card { background: #1e293b; border-radius: 10px; padding: 14px; border-left: 5px solid #10b981; transition: 0.3s; }
    .card.idle { border-left-color: #f59e0b; }
    .card.mock { border-left-color: #ef4444; background: #450a0a; }
    .card.sos { border-left-color: #dc2626; background: #7f1d1d; animation: pulse 1s infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.7); } 70% { box-shadow: 0 0 0 10px rgba(220, 38, 38, 0); } 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0); } }
    .title { font-size: 16px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; font-size: 13px; }
    .stat-box { background: #0f172a; padding: 8px; border-radius: 6px; }
    .badge { padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .bg-green { background: #065f46; color: #34d399; }
    .bg-amber { background: #78350f; color: #fbbf24; }
    .bg-red { background: #991b1b; color: #f87171; }
    .bg-sos { background: #dc2626; color: white; border: 1px solid white; }
    .btn-row { display: flex; gap: 8px; margin-top: 10px; }
    button.action-btn { flex: 1; padding: 8px; border: none; border-radius: 6px; background: #3b82f6; color: white; font-weight: 600; cursor: pointer; font-size: 12px; }
    button.clappia { background: #10b981; }
    button.btn-sos { background: #dc2626; border: 1px solid #f87171; }
    .filter-input { background: #1e293b; color: white; border: 1px solid #3b82f6; padding: 10px; border-radius: 6px; width: 100%; margin-bottom: 5px; font-size: 14px; }
    .header-row { display: flex; justify-content: space-between; align-items: center; }
    .close-btn { background: none; border: none; color: white; font-size: 24px; cursor: pointer; display: none; }
    @media (max-width: 768px) { .close-btn { display: block; } }
  </style>
</head>
<body class="sidebar-closed">
  <button class="float-btn menu-btn" onclick="toggleSidebar()">☰ Menu</button>
  <div class="floating-controls">
    <button class="float-btn" onclick="fitAllVans()">🌍 Fit All</button>
    <button class="float-btn" onclick="toggleFullScreen()">⛶ Fullscreen</button>
  </div>
  <div id="sidebar">
    <div class="header-row">
      <h2>🚐 Van Tracker</h2>
      <button class="close-btn" onclick="toggleSidebar()">×</button>
    </div>
    <input type="date" id="dateFilter" class="filter-input" onchange="handleFilters()" />
    <select id="driverFilter" class="filter-input" onchange="handleFilters()">
      <option value="all">🚙 All Drivers</option>
    </select>
    <div id="van-list">Waiting for GPS ping...</div>
  </div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map', { zoomControl: false }).setView([28.5355, 77.3910], 12);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b', '#10b981'];
    const layers = {};
    let refreshInterval;

    const dateInput = document.getElementById('dateFilter');
    const driverInput = document.getElementById('driverFilter');
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    dateInput.value = todayStr;
    dateInput.max = todayStr;

    function toggleSidebar() { document.body.classList.toggle('sidebar-closed'); setTimeout(() => map.invalidateSize(), 350); }
    function toggleFullScreen() { if (!document.fullscreenElement) { document.documentElement.requestFullscreen().catch(() => alert("Fullscreen blocked by browser")); } else { document.exitFullscreen(); } }
    function fitAllVans() { const markers = Object.values(layers).map(l => l.marker); if (markers.length > 0) { const group = new L.featureGroup(markers); map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 16 }); } }
    async function pushVanToClappia(deviceId, btnEl) { btnEl.innerText = '⏳ Pushing...'; try { const res = await fetch('/api/push-to-clappia/' + encodeURIComponent(deviceId), { method: 'POST' }); btnEl.innerText = res.ok ? '✅ Sent' : '❌ Failed'; } catch (e) { btnEl.innerText = '❌ Error'; } }
    async function clearSos(deviceId) { await fetch('/api/clear-sos/' + encodeURIComponent(deviceId), { method: 'POST' }); refreshData(); }
    function handleFilters() { refreshData(true); clearInterval(refreshInterval); if (dateInput.value === todayStr) { refreshInterval = setInterval(refreshData, 5000); } }
    
    function updateDriverDropdown(keys) {
      const currentVal = driverInput.value;
      driverInput.innerHTML = '<option value="all">🚙 All Drivers</option>';
      keys.forEach(k => { const opt = document.createElement('option'); opt.value = k; opt.innerText = '🚐 ' + k; if(k === currentVal) opt.selected = true; driverInput.appendChild(opt); });
    }

    async function refreshData(forceZoom = false) {
      const selectedDate = dateInput.value;
      const isToday = selectedDate === todayStr;
      const selectedDriver = driverInput.value;
      const res = await fetch(isToday ? '/api/vans' : '/api/history/' + selectedDate);
      const vans = await res.json();
      const listEl = document.getElementById('van-list');
      const keys = Object.keys(vans);
      
      updateDriverDropdown(keys);

      if (keys.length === 0) {
        listEl.innerHTML = '<div style="padding:10px; color:#94a3b8;">No data for this date.</div>';
        Object.values(layers).forEach(l => { map.removeLayer(l.marker); map.removeLayer(l.polyline); });
        return;
      }
      
      listEl.innerHTML = '';
      Object.keys(layers).forEach(id => {
        if (!keys.includes(id) || (selectedDriver !== 'all' && id !== selectedDriver)) {
          map.removeLayer(layers[id].polyline); map.removeLayer(layers[id].marker); layers[id].haltMarkers.forEach(m => map.removeLayer(m)); delete layers[id];
        }
      });

      keys.forEach((id, idx) => {
        if (selectedDriver !== 'all' && id !== selectedDriver) return;
        const v = vans[id];
        const color = colors[idx % colors.length];
        const secAgo = Math.round((Date.now() - v.lastSeen) / 1000);
        
        let statusBadge = isToday ? '<span class="badge bg-green">MOVING</span>' : '<span class="badge bg-amber">ARCHIVED</span>';
        let cardClass = 'card';
        if (v.sosAlert && isToday) { statusBadge = '<span class="badge bg-sos">🆘 SOS EMERGENCY</span>'; cardClass = 'card sos'; } 
        else if (v.isMockDetected) { statusBadge = '<span class="badge bg-red">🚨 FAKE GPS</span>'; cardClass = 'card mock'; } 
        else if (v.idleMinutes >= 10 && isToday) { statusBadge = '<span class="badge bg-amber">⚠️ PARKED ' + v.idleMinutes + 'M</span>'; cardClass = 'card idle'; }

        const card = document.createElement('div');
        card.className = cardClass;
        let dismissBtn = (v.sosAlert && isToday) ? \`<button class="action-btn btn-sos" onclick="clearSos('\${v.deviceId}')">🔕 Clear</button>\` : '';
        let clappiaBtn = isToday ? \`<button class="action-btn clappia" onclick="pushVanToClappia('\${v.deviceId}', this)">🚀 Clappia</button>\` : '';

        card.innerHTML = \`
          <div class="title"><span style="color:\${color}">● \${v.deviceId}</span>\${statusBadge}</div>
          <div class="stat-grid">
            <div class="stat-box">🛣️ <b>\${v.totalKm} KM</b></div>
            <div class="stat-box">🔋 <b>\${v.battery}%</b></div>
            <div class="stat-box">🛑 <b>\${isToday ? v.idleMinutes + 'm' : '---'}</b> (\${v.halts.length})</div>
            <div class="stat-box">⏱️ <b>\${isToday ? secAgo + 's' : '---'}</b> ago</div>
          </div>
          <div class="btn-row">
            <button class="action-btn" onclick="map.setView([\${v.currentLat}, \${v.currentLon}], 16); if(window.innerWidth<=768) toggleSidebar();">📍 Center</button>
            \${dismissBtn}
            \${!v.sosAlert ? clappiaBtn : ''} 
          </div>
        \`;
        listEl.appendChild(card);

        if (layers[id]) { map.removeLayer(layers[id].polyline); map.removeLayer(layers[id].marker); layers[id].haltMarkers.forEach(m => map.removeLayer(m)); }
        const polyline = L.polyline(v.points.map(p => [p.lat, p.lon]), { color, weight: 4 }).addTo(map);
        let markerRadius = v.sosAlert ? 12 : 8;
        let markerColor = v.sosAlert ? '#dc2626' : (v.isMockDetected ? '#ef4444' : color);
        const marker = L.circleMarker([v.currentLat, v.currentLon], { radius: markerRadius, fillColor: markerColor, color: '#fff', weight: 2, fillOpacity: 1 }).addTo(map);
        const haltMarkers = (v.halts || []).map(h => L.circleMarker([h.lat, h.lon], { radius: 5, fillColor: '#f59e0b', color: '#000', weight: 1, fillOpacity: 0.9 }).addTo(map).bindPopup(\`🛑 Parked \${h.durationMin}m (\${h.endedAt})\`));
        layers[id] = { polyline, marker, haltMarkers };
      });
      if (forceZoom) fitAllVans();
    }
    
    handleFilters();
  </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
