require("dotenv").config();
// server.js (Render Production Ready - Final with Date Filter)
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

// Auto-reset in-memory vans when a new day starts in IST
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

// 1. OPTIONAL MONGODB PERSISTENCE (Prevents Render restarts from wiping routes)
let VanStateModel = null;
let isDbRestored = false;

if (process.env.MONGO_URI) {
  const vanSchema = new mongoose.Schema({
    dateKey: { type: String, unique: true }, // e.g., "2026-10-22"
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

// Load today's routes from MongoDB on Render startup
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

// Save state to MongoDB (debounced every 60s)
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

// 2. KEEP-ALIVE ENDPOINT (Prevents Render from sleeping during duty hours)
app.get("/health", (req, res) => res.status(200).send("ALIVE"));

if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    const hourIST = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    ).getHours();
    // Keep server awake between 8 AM and 9 PM IST
    if (hourIST >= 8 && hourIST <= 21) {
      axios.get(`${process.env.RENDER_EXTERNAL_URL}/health`).catch(() => {});
    }
  }, 10 * 60 * 1000);
}

// Haversine Distance Formula (KM)
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

// 3. TRACCAR CLIENT RECEIVER + DASHBOARD ROUTE
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

    const lat = parseFloat(coords.latitude ?? q.lat);
    const lon = parseFloat(coords.longitude ?? q.lon);
    if (isNaN(lat) || isNaN(lon)) return res.status(200).send("OK");

    const speedKnotsOrMps = parseFloat(coords.speed ?? q.speed ?? 0);
    const speedKmh = Math.max(0, +(speedKnotsOrMps * 3.6).toFixed(1));
    const battery =
      battObj.level !== undefined
        ? Math.round(battObj.level * 100)
        : parseFloat(q.batt ?? 100);
    const isMock = Boolean(
      loc.mock === true || coords.mock === true || q.mock === "true" || q.mock === true
    );
    const now = Date.now();

    if (!vans[deviceId]) {
      vans[deviceId] = {
        deviceId,
        totalKm: 0,
        isMockDetected: false,
        battery: isNaN(battery) ? 100 : battery,
        lastSeen: now,
        idleSince: now,
        idleMinutes: 0,
        currentLat: lat,
        currentLon: lon,
        idleAnchorLat: lat,
        idleAnchorLon: lon,
        points: [],
        halts: []
      };
    }

    const van = vans[deviceId];
    const prevPoint = van.points[van.points.length - 1];

    if (prevPoint) {
      const distKm = getDistanceKm(prevPoint.lat, prevPoint.lon, lat, lon);
      if (distKm >= 0.015 && distKm < 5.0) {
        van.totalKm = +(van.totalKm + distKm).toFixed(2);
      }

      const distFromIdleAnchor = getDistanceKm(
        van.idleAnchorLat || prevPoint.lat,
        van.idleAnchorLon || prevPoint.lon,
        lat,
        lon
      );

      if (distFromIdleAnchor < 0.04) {
        van.idleMinutes = Math.round((now - van.idleSince) / 60000);
      } else {
        if (van.idleMinutes >= 10) {
          van.halts.push({
            lat: van.idleAnchorLat,
            lon: van.idleAnchorLon,
            durationMin: van.idleMinutes,
            endedAt: new Date(now).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
          });
        }
        van.idleSince = now;
        van.idleMinutes = 0;
        van.idleAnchorLat = lat;
        van.idleAnchorLon = lon;
      }
    }

    if (isMock) van.isMockDetected = true;
    if (!isNaN(battery)) van.battery = battery;
    van.lastSeen = now;
    van.currentLat = lat;
    van.currentLon = lon;

    van.points.push({
      lat,
      lon,
      time: new Date(now).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
      speedKmh,
      battery: van.battery,
      isMock
    });

    await backupStateToDB(van.points.length === 1); // Force immediate DB save on first ping
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Ping error:", err.message);
    return res.status(200).send("OK");
  }
});

// 4. API ENDPOINTS FOR DASHBOARD & CLAPPIA SYNC
app.get("/api/vans", (req, res) => {
  checkMidnightReset();
  res.json(vans);
});

// Fetch historical data by date (YYYY-MM-DD)
app.get("/api/history/:date", async (req, res) => {
  if (!VanStateModel) return res.status(500).json({ error: "MongoDB not enabled" });
  try {
    const doc = await VanStateModel.findOne({ dateKey: req.params.date });
    res.json(doc ? doc.vansData : {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/push-to-clappia/:deviceId", async (req, res) => {
  const van = vans[req.params.deviceId];
  if (!van) return res.status(404).json({ error: "Van not found" });
  if (!CLAPPIA_CONFIG.apiKey || !CLAPPIA_CONFIG.userEmail) {
    return res.status(400).json({ error: "Missing CLAPPIA_API_KEY or CLAPPIA_USER_EMAIL in .env" });
  }

  try {
    const response = await axios.post(
      "https://api-public-v4.clappia.com/submissions/create",
      {
        appId: CLAPPIA_CONFIG.appId,
        workplaceId: CLAPPIA_CONFIG.workplaceId,
        requestingUserEmailAddress: CLAPPIA_CONFIG.userEmail,
        data: {
          customer_n: `${van.deviceId} | ${van.totalKm} KM | Halts: ${van.halts.length} | Mock: ${van.isMockDetected ? "YES" : "NO"}`,
          phone_numb: `${van.currentLat.toFixed(5)},${van.currentLon.toFixed(5)}`,
          source: ["Babbler Disposition"]
        }
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CLAPPIA_CONFIG.apiKey
        }
      }
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
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
    body { display: flex; height: 100vh; background: #0f172a; color: #f8fafc; }
    #sidebar { width: 360px; padding: 16px; overflow-y: auto; border-right: 1px solid #1e293b; display: flex; flex-direction: column; gap: 14px; }
    #map { flex: 1; height: 100%; }
    .card { background: #1e293b; border-radius: 10px; padding: 14px; border-left: 5px solid #10b981; }
    .card.idle { border-left-color: #f59e0b; }
    .card.mock { border-left-color: #ef4444; background: #450a0a; }
    .title { font-size: 16px; font-weight: 700; display: flex; justify-content: space-between; align-items: center; }
    .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; font-size: 13px; }
    .stat-box { background: #0f172a; padding: 8px; border-radius: 6px; }
    .badge { padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; }
    .bg-green { background: #065f46; color: #34d399; }
    .bg-amber { background: #78350f; color: #fbbf24; }
    .bg-red { background: #991b1b; color: #f87171; }
    .btn-row { display: flex; gap: 8px; margin-top: 10px; }
    button { flex: 1; padding: 8px; border: none; border-radius: 6px; background: #3b82f6; color: white; font-weight: 600; cursor: pointer; font-size: 12px; }
    button.clappia { background: #10b981; }
    .date-filter { background: #1e293b; color: white; border: 1px solid #3b82f6; padding: 8px; border-radius: 6px; width: 100%; margin-bottom: 10px; }
  </style>
</head>
<body>
  <div id="sidebar">
    <h2>🚐 Van Tracker</h2>
    <input type="date" id="dateFilter" class="date-filter" onchange="handleDateChange()" />
    <div id="van-list">Waiting for GPS ping...</div>
  </div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([28.5355, 77.3910], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
    const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
    const layers = {};
    let refreshInterval;

    const dateInput = document.getElementById('dateFilter');
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    dateInput.value = todayStr;
    dateInput.max = todayStr;

    async function pushVanToClappia(deviceId, btnEl) {
      btnEl.innerText = '⏳ Pushing...';
      try {
        const res = await fetch('/api/push-to-clappia/' + encodeURIComponent(deviceId), { method: 'POST' });
        const data = await res.json();
        btnEl.innerText = res.ok ? '✅ Sent to Clappia' : '❌ Failed';
      } catch (e) {
        btnEl.innerText = '❌ Error';
      }
    }

    function handleDateChange() {
      refreshData();
      clearInterval(refreshInterval);
      if (dateInput.value === todayStr) {
        refreshInterval = setInterval(refreshData, 5000);
      }
    }

    async function refreshData() {
      const selectedDate = dateInput.value;
      const isToday = selectedDate === todayStr;
      const endpoint = isToday ? '/api/vans' : '/api/history/' + selectedDate;
      
      const res = await fetch(endpoint);
      const vans = await res.json();
      const listEl = document.getElementById('van-list');
      const keys = Object.keys(vans);
      
      if (keys.length === 0) {
        listEl.innerHTML = '<div style="padding:10px; color:#94a3b8;">No data for this date.</div>';
        Object.keys(layers).forEach(id => {
          map.removeLayer(layers[id].polyline);
          map.removeLayer(layers[id].marker);
          layers[id].haltMarkers.forEach(m => map.removeLayer(m));
        });
        return;
      }
      listEl.innerHTML = '';

      keys.forEach((id, idx) => {
        const v = vans[id];
        const color = colors[idx % colors.length];
        const secAgo = Math.round((Date.now() - v.lastSeen) / 1000);
        
        let statusBadge = isToday ? '<span class="badge bg-green">MOVING</span>' : '<span class="badge bg-amber">ARCHIVED</span>';
        let cardClass = 'card';
        if (v.isMockDetected) {
          statusBadge = '<span class="badge bg-red">🚨 FAKE GPS</span>';
          cardClass = 'card mock';
        } else if (v.idleMinutes >= 10 && isToday) {
          statusBadge = '<span class="badge bg-amber">⚠️ PARKED ' + v.idleMinutes + 'M</span>';
          cardClass = 'card idle';
        }

        const card = document.createElement('div');
        card.className = cardClass;
        card.innerHTML = \`
          <div class="title"><span style="color:\${color}">● \${v.deviceId}</span>\${statusBadge}</div>
          <div class="stat-grid">
            <div class="stat-box">🛣️ <b>\${v.totalKm} KM</b><br><span style="color:#94a3b8">Distance</span></div>
            <div class="stat-box">🔋 <b>\${v.battery}%</b><br><span style="color:#94a3b8">Battery</span></div>
            <div class="stat-box">🛑 <b>\${isToday ? v.idleMinutes + ' min' : '---'}</b><br><span style="color:#94a3b8">Parked (\${v.halts.length} halts)</span></div>
            <div class="stat-box">⏱️ <b>\${isToday ? secAgo + 's ago' : '---'}</b><br><span style="color:#94a3b8">Last Ping</span></div>
          </div>
          <div class="btn-row">
            <button onclick="map.setView([\${v.currentLat}, \${v.currentLon}], 16)">📍 Center Map</button>
            \${isToday ? \`<button class="clappia" onclick="pushVanToClappia('\${v.deviceId}', this)">🚀 Push Clappia</button>\` : ''}
          </div>
        \`;
        listEl.appendChild(card);

        if (layers[id]) {
          map.removeLayer(layers[id].polyline);
          map.removeLayer(layers[id].marker);
          layers[id].haltMarkers.forEach(m => map.removeLayer(m));
        }

        const polyline = L.polyline(v.points.map(p => [p.lat, p.lon]), { color, weight: 5 }).addTo(map);
        const marker = L.circleMarker([v.currentLat, v.currentLon], {
          radius: 9, fillColor: v.isMockDetected ? '#ef4444' : color, color: '#fff', weight: 2, fillOpacity: 1
        }).addTo(map);
        const haltMarkers = (v.halts || []).map(h =>
          L.circleMarker([h.lat, h.lon], { radius: 6, fillColor: '#f59e0b', color: '#000', weight: 1, fillOpacity: 0.9 })
            .addTo(map).bindPopup(\`🛑 Parked \${h.durationMin} mins (until \${h.endedAt})\`)
        );
        layers[id] = { polyline, marker, haltMarkers };
      });
    }
    
    handleDateChange();
  </script>
</body>
</html>`;
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Tracker listening on port ${PORT}`));
