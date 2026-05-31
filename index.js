const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors()); // Allow your frontend portal to fetch this API

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'rain_data_cache.json');

const API_KEY = "a10187411c5bc066f220a98aa88a52e7:e29a0c11f5cbb5b45cffc80a835fa790f0dc5369198fd6b366e1c488520f57589d4e078d9105836db968f6c5ce8bc370c740ad1c7b4d88cecace41c7f976e5b2908d5427c664302b1c080d5536d854e54f91792738e05f67e611c9bb8504300cfc8c88601a7f2e7bfb1028194c3614a6e1cc427d95b2af4194058954f6b7af814c82e3aebc45b0629f64504bd52b75392e578708024ddb206a9b29976ab9a8a8aa9c3b75c8bcc9062492747d01a2b40600a407df33078e835f977a71ffeec167ce87c9bc2311630acb4edb9da978a78d2a8e707c7c91d990e485ac2ce318f5ba5a8a655e53b96c636fa642d03ad45ecb";
const BASE_URL = "https://http.api.connectivity-dynasys.garajcloud.com/api";
const RAIN_GAUGE_TYPE_ID = "67fd6a83336210a2d40cba16";

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan Time (UTC+5)
const axiosConfig = { headers: { "api-key": API_KEY } };

// ═══════════════════════════════════════════════════════════════
// DEVICE / ASSET FETCH HELPERS
// ═══════════════════════════════════════════════════════════════

// Pull the entire device list in one call (no deviceType filter) so we get
// rain gauges AND weather stations together. GarajCloud paginates with skip
// /limit — for now 200 covers both types comfortably (87 RG + 3 WS = 90).
async function getAllDevices() {
    const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
    const res = await axios.get(url, { ...axiosConfig, params: { skip: 0, limit: 200 } });
    return res.data?.data?.devices ?? [];
}

// Fallback path (kept so the rain-gauge-only sync still works if the no-
// filter call ever returns something unexpected).
async function getDevicesByType(deviceTypeId) {
    const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
    const res = await axios.get(url, { ...axiosConfig, params: { deviceType: deviceTypeId, skip: 0, limit: 100 } });
    return res.data?.data?.devices ?? [];
}

// Per-sync asset cache so multiple devices pointing at the same asset only
// trigger one HTTP call. Wiped at the start of every sync to avoid serving
// stale coordinates if an asset ever moves.
let _assetCache = new Map();

async function getAssetById(assetId) {
    if (!assetId) return null;
    if (_assetCache.has(assetId)) return _assetCache.get(assetId);
    try {
        const url = `${BASE_URL}/apps/ignite-shield/external/assets/${assetId}`;
        const res = await axios.get(url, axiosConfig);
        // Response could be { data: { asset } } or { data: <asset> } depending
        // on the API style — handle both.
        const asset = res.data?.data?.asset ?? res.data?.data ?? res.data ?? null;
        _assetCache.set(assetId, asset);
        return asset;
    } catch (e) {
        // Don't fail the sync for a single asset lookup — just record null
        // coords for that device.
        console.warn(`[asset] ${assetId}: ${e.message}`);
        _assetCache.set(assetId, null);
        return null;
    }
}

// Pull lat/lng off a GarajCloud asset payload. Confirmed shape (from DynaSys):
//   asset.geoLocation = { type: 'Point', coordinates: [lng, lat] }
// Still defensive — falls back to other common paths so a single API change
// upstream doesn't blank out every map pin.
function extractCoordsFromAsset(asset) {
    if (!asset || typeof asset !== 'object') return { lat: null, lng: null };
    const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    // Confirmed GarajCloud shape (GeoJSON Point — [lng, lat] order)
    if (Array.isArray(asset.geoLocation?.coordinates) && asset.geoLocation.coordinates.length >= 2) {
        return { lat: num(asset.geoLocation.coordinates[1]), lng: num(asset.geoLocation.coordinates[0]) };
    }

    // Defensive fallbacks
    if (Array.isArray(asset.location?.coordinates) && asset.location.coordinates.length >= 2) {
        return { lat: num(asset.location.coordinates[1]), lng: num(asset.location.coordinates[0]) };
    }
    const lat = num(asset.lat ?? asset.latitude ?? asset.location?.lat ?? asset.location?.latitude);
    const lng = num(asset.lng ?? asset.lon ?? asset.longitude ?? asset.location?.lng ?? asset.location?.lon ?? asset.location?.longitude);
    return { lat, lng };
}

function buildRanges() {
    const now = new Date();
    const pktNow = new Date(now.getTime() + PKT_OFFSET_MS);
    const toUtc = (pkt) => new Date(pkt.getTime() - PKT_OFFSET_MS).toISOString();

    // 12:00 AM (midnight) today in Pakistan Time
    const todayMidnight = new Date(pktNow);
    todayMidnight.setUTCHours(0, 0, 0, 0);

    // January 1st of the current year, 12:00 AM Pakistan Time
    const janFirst = new Date(pktNow);
    janFirst.setUTCMonth(0, 1);
    janFirst.setUTCHours(0, 0, 0, 0);

    // Arbitrary past date to cover "since installation"
    const installationDate = new Date(Date.UTC(2010, 0, 1));

    return {
        "24h": { unit: "hour", start: toUtc(new Date(pktNow.getTime() - 24 * 3600000)), end: toUtc(pktNow) },
        "daily": { unit: "hour", start: toUtc(todayMidnight), end: toUtc(pktNow) },
        "7d": { unit: "day", start: toUtc(new Date(todayMidnight.getTime() - 7 * 86400000)), end: toUtc(pktNow) },
        "30d": { unit: "day", start: toUtc(new Date(todayMidnight.getTime() - 30 * 86400000)), end: toUtc(pktNow) },
        "this_year": { unit: "month", start: toUtc(janFirst), end: toUtc(pktNow) },
        "all_time": { unit: "month", start: installationDate.toISOString(), end: toUtc(pktNow) }
    };
}

// ═══════════════════════════════════════════════════════════════
// PER-DEVICE FETCH HELPERS
// ═══════════════════════════════════════════════════════════════

async function fetchRainfallTotals(deviceId, ranges) {
    const out = {};
    for (const [period, range] of Object.entries(ranges)) {
        try {
            const url = `${BASE_URL}/apps/ignite-shield/external/readings/statistics/current-rainfall`;
            const res = await axios.get(url, {
                ...axiosConfig,
                params: {
                    "timestamp.gte": range.start,
                    "timestamp.lte": range.end,
                    device: deviceId,
                    unit: range.unit,
                    aggregationType: "Sum"
                }
            });
            const stats = res.data?.data?.statistics ?? [];
            const total = stats.reduce((sum, s) => sum + (s.value || 0), 0);
            out[period] = Math.round(total * 100) / 100;
        } catch (e) {
            out[period] = null;
            out[`${period}_error`] = e.message;
        }
    }
    return out;
}

// Resolve coordinates for one device by looking up its asset (cached).
async function resolveCoords(dev) {
    const assetId = typeof dev.asset === 'string' ? dev.asset : (dev.asset?._id || dev.asset?.id || null);
    if (!assetId) return { lat: null, lng: null };
    const asset = await getAssetById(assetId);
    return extractCoordsFromAsset(asset);
}

async function buildRainGaugeRow(dev, ranges) {
    const coords = await resolveCoords(dev);
    const row = {
        id: dev._id,
        name: dev.name,
        status: dev.state?.status,
        lat: coords.lat,
        lng: coords.lng,
    };
    Object.assign(row, await fetchRainfallTotals(dev._id, ranges));
    return row;
}

// Pull a numeric reading out of GarajCloud's lastReading map. Keys look like
// "Temperature-˚C", "Wind_Speed-m/s", etc. — we match on the leading
// parameter name (everything before the first `-`) so unit drift on the
// upstream side doesn't blank the field.
function readingValue(lastReading, parameterName) {
    if (!lastReading || typeof lastReading !== 'object') return null;
    const target = String(parameterName).toLowerCase();
    for (const [k, v] of Object.entries(lastReading)) {
        const param = String(k).split('-')[0].trim().toLowerCase();
        if (param === target) {
            const n = Number(v?.value);
            return Number.isFinite(n) ? n : null;
        }
    }
    return null;
}

// Weather stations expose temp / humidity / wind / pressure / heat index
// in the device's `lastReading` map. We flatten the values out so the row
// stays compact and the dashboard doesn't have to parse GarajCloud's
// parameter-key-unit shape itself. Rainfall isn't surfaced for WS because
// one of the stations returns an obvious overflow value (~42M mm) and the
// other two report 0 — it's not a useful field here.
async function buildWeatherStationRow(dev) {
    const coords = await resolveCoords(dev);
    const lr = dev.lastReading || {};
    return {
        id: dev._id,
        name: dev.name,
        status: dev.state?.status,
        lat: coords.lat,
        lng: coords.lng,
        temperature:    readingValue(lr, 'Temperature'),
        humidity:       readingValue(lr, 'Relative_Humidity'),
        wind_direction: readingValue(lr, 'Wind_Direction'),
        wind_speed:     readingValue(lr, 'Wind_Speed'),
        pressure:       readingValue(lr, 'Pressure'),
        heat_index:     readingValue(lr, 'Heat_Index'),
    };
}

// ═══════════════════════════════════════════════════════════════
// BACKGROUND SYNC LOGIC
// ═══════════════════════════════════════════════════════════════
let isSyncing = false;

async function syncAllData() {
    if (isSyncing) return;
    isSyncing = true;
    _assetCache = new Map(); // fresh cache per sync
    console.log(`[${new Date().toISOString()}] Starting full data sync...`);

    try {
        const ranges = buildRanges();

        // ── Fetch everything in one call, then split by name prefix ──────────
        // (DynaSys confirmed: rain gauges are named "RG - ..." and weather
        // stations are named "WS - ...".)
        let allDevices = [];
        try {
            allDevices = await getAllDevices();
        } catch (e) {
            console.warn(`[sync] getAllDevices failed, falling back to rain-gauge-only: ${e.message}`);
            allDevices = await getDevicesByType(RAIN_GAUGE_TYPE_ID);
        }

        const rainDevices = allDevices.filter(d => /^RG/i.test((d.name || '').trim()));
        const wsDevices = allDevices.filter(d => /^WS/i.test((d.name || '').trim()));
        const unrecognised = allDevices.length - rainDevices.length - wsDevices.length;
        if (unrecognised > 0) {
            console.warn(`[sync] ${unrecognised} devices didn't match RG/WS name prefix and will be skipped.`);
        }

        // ── Rain gauges ──────────────────────────────────────────────────────
        const rainGauges = [];
        const chunkSize = 10; // batch so we don't overwhelm GarajCloud
        for (let i = 0; i < rainDevices.length; i += chunkSize) {
            const chunk = rainDevices.slice(i, i + chunkSize);
            const rows = await Promise.all(chunk.map(d => buildRainGaugeRow(d, ranges)));
            rainGauges.push(...rows);
        }
        rainGauges.sort((a, b) => (b["24h"] ?? 0) - (a["24h"] ?? 0));

        // ── Weather stations ────────────────────────────────────────────────
        // No rainfall fetch for WS (one device returns a 32-bit overflow value
        // upstream; the other two report 0) — temp/humidity/wind/pressure
        // come straight from the device's lastReading map.
        const weatherStations = await Promise.all(wsDevices.map(d => buildWeatherStationRow(d)));

        // `/api` returns RG + WS combined so the Cloudflare Worker (which
        // hits `/api` and writes one row per device to D1 every 15 min)
        // tracks uptime/downtime for ALL devices, not just rain gauges.
        // Each device is identifiable by the `RG - ` / `WS - ` name prefix.
        const finalData = {
            lastUpdated: new Date().toISOString(),
            devices: [...rainGauges, ...weatherStations],
            rainGauges,
            weatherStations,
        };

        fs.writeFileSync(CACHE_FILE, JSON.stringify(finalData, null, 2));
        console.log(`[${new Date().toISOString()}] Sync complete! Saved ${rainGauges.length} rain gauges, ${weatherStations.length} weather stations (${finalData.devices.length} total). Assets cached: ${_assetCache.size}.`);

    } catch (e) {
        console.error("Critical error during sync:", e.message);
    } finally {
        isSyncing = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

function readCache() {
    if (!fs.existsSync(CACHE_FILE)) return null;
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE));
    } catch (e) {
        return null;
    }
}

// Lightweight endpoint just to keep the server awake (use this for cron-job.org)
app.get('/ping', (req, res) => {
    res.send('ok');
});

// Main endpoint for your dashboard. `devices` is the combined list of
// rain gauges + weather stations (90 total) so the Cloudflare Worker
// tracks uptime/downtime for all devices. Each row carries `lat`, `lng`;
// rain gauges carry the rainfall window fields (24h/daily/7d/30d/...);
// weather stations carry temperature/humidity/wind_*/pressure/heat_index.
// Identify each by the `RG - ` / `WS - ` name prefix.
app.get('/api', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    res.json({ lastUpdated: data.lastUpdated, devices: data.devices || data.rainGauges || [] });
});

// Rain gauges + weather stations in one response.
app.get('/api/all', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    res.json({
        lastUpdated: data.lastUpdated,
        rainGauges: data.rainGauges || data.devices || [],
        weatherStations: data.weatherStations || [],
    });
});

// Weather stations only.
app.get('/api/weather-stations', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    res.json({
        lastUpdated: data.lastUpdated,
        devices: data.weatherStations || [],
    });
});

// Force sync endpoint for testing
app.get('/force-sync', (req, res) => {
    syncAllData(); // run in background
    res.json({ message: "Background sync triggered." });
});

// ── DEBUG ENDPOINTS ──────────────────────────────────────────────────────
// Dump one raw device payload (rain gauge by default; pass ?type=ws for a
// weather station) so we can see GarajCloud's full response.
app.get('/api/debug/device-raw', async (req, res) => {
    try {
        const all = await getAllDevices();
        const wanted = req.query.type === 'ws'
            ? all.find(d => /^WS/i.test(d.name || ''))
            : all.find(d => /^RG/i.test(d.name || ''));
        res.json(wanted || { error: "no matching device" });
    } catch (e) {
        res.status(500).json({ error: e.message, response: e.response?.data });
    }
});

// Dump one raw asset payload to confirm geoLocation.coordinates shape.
app.get('/api/debug/asset-raw', async (req, res) => {
    try {
        const all = await getAllDevices();
        const first = all[0];
        if (!first) return res.json({ error: "no devices" });
        const assetId = typeof first.asset === 'string' ? first.asset : (first.asset?._id || first.asset?.id);
        if (!assetId) return res.json({ error: "no asset on first device", device: first });
        const url = `${BASE_URL}/apps/ignite-shield/external/assets/${assetId}`;
        const r = await axios.get(url, axiosConfig);
        res.json({ assetId, asset: r.data });
    } catch (e) {
        res.status(500).json({ error: e.message, response: e.response?.data });
    }
});

// ═══════════════════════════════════════════════════════════════
// SERVER STARTUP & CRON SCHEDULE
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);

    cron.schedule('*/10 * * * *', () => {
        syncAllData();
    });

    if (!fs.existsSync(CACHE_FILE)) {
        syncAllData();
    }
});
