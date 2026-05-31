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

// Weather-station device type ID is auto-discovered the first time the sync
// runs by querying /external/device-types and matching by name. Setting this
// to a hard-coded value here will short-circuit discovery if it's ever needed.
let WEATHER_STATION_TYPE_ID = null;

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan Time (UTC+5)
const axiosConfig = { headers: { "api-key": API_KEY } };

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════
async function getDevicesByType(deviceTypeId) {
    const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
    const res = await axios.get(url, { ...axiosConfig, params: { deviceType: deviceTypeId, skip: 0, limit: 100 } });
    return res.data?.data?.devices ?? [];
}

// Kept for backwards compatibility with anything that imported the old name.
async function getDevices() {
    return getDevicesByType(RAIN_GAUGE_TYPE_ID);
}

async function getDeviceTypes() {
    const url = `${BASE_URL}/apps/ignite-shield/external/device-types`;
    const res = await axios.get(url, axiosConfig);
    // GarajCloud often nests collections at .data.<entityName> — try a few paths.
    return res.data?.data?.deviceTypes
        ?? res.data?.data?.types
        ?? res.data?.data
        ?? [];
}

// Look up the weather-station device type ID by name. Cached on success so we
// only do this once per process. Best-effort — if the API isn't shaped how we
// expect, we return null and the sync continues with rain-gauges only.
async function discoverWeatherStationTypeId() {
    if (WEATHER_STATION_TYPE_ID) return WEATHER_STATION_TYPE_ID;
    try {
        const types = await getDeviceTypes();
        const list = Array.isArray(types) ? types : Object.values(types || {});
        const match = list.find(t => /weather\s*station|^WS\b/i.test(t?.name || ''));
        if (match?._id) {
            WEATHER_STATION_TYPE_ID = match._id;
            console.log(`[discover] weather-station device type id: ${WEATHER_STATION_TYPE_ID} (${match.name})`);
        } else {
            console.log(`[discover] weather-station device type not found in /external/device-types response (${list.length} types listed). Hit /api/debug/device-types to inspect.`);
        }
    } catch (e) {
        console.warn(`[discover] failed to list device types: ${e.message}`);
    }
    return WEATHER_STATION_TYPE_ID;
}

// Pull lat/lng off a GarajCloud device payload. Tries several common shapes
// without throwing if any of them are missing — returns nulls when nothing
// looks like coordinates.
function extractCoords(dev) {
    if (!dev || typeof dev !== 'object') return { lat: null, lng: null };
    const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    // GeoJSON shape: location.coordinates = [lng, lat]
    if (Array.isArray(dev.location?.coordinates) && dev.location.coordinates.length >= 2) {
        return { lat: num(dev.location.coordinates[1]), lng: num(dev.location.coordinates[0]) };
    }
    if (Array.isArray(dev.coordinates) && dev.coordinates.length >= 2) {
        return { lat: num(dev.coordinates[1]), lng: num(dev.coordinates[0]) };
    }

    // Common flat / nested fields
    const lat = num(dev.lat ?? dev.latitude ?? dev.location?.lat ?? dev.location?.latitude ?? dev.geo?.lat);
    const lng = num(dev.lng ?? dev.lon ?? dev.longitude ?? dev.location?.lng ?? dev.location?.lon ?? dev.location?.longitude ?? dev.geo?.lng ?? dev.geo?.lon);
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

// Rainfall totals across the 6 standard time windows for one device. Used for
// rain gauges (and weather stations that report rain too — same metric name).
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

// Build the row we serve to the dashboard for a rain gauge. Same shape as the
// original `syncAllData` produced, but now also includes lat / lng / type.
async function buildRainGaugeRow(dev, ranges) {
    const coords = extractCoords(dev);
    const row = {
        id: dev._id,
        name: dev.name,
        type: 'rain_gauge',
        status: dev.state?.status,
        lat: coords.lat,
        lng: coords.lng,
    };
    Object.assign(row, await fetchRainfallTotals(dev._id, ranges));
    return row;
}

// Weather stations expose more parameters (temp, humidity, wind, pressure).
// We don't yet know the exact reading field names on GarajCloud's side, so we
// pass through the device's `state` object verbatim and let downstream code
// pick out what it needs. We also include rainfall totals because the user
// said these stations are "full-fledged" — they may well have rain sensors.
async function buildWeatherStationRow(dev, ranges) {
    const coords = extractCoords(dev);
    const row = {
        id: dev._id,
        name: dev.name,
        type: 'weather_station',
        status: dev.state?.status,
        lat: coords.lat,
        lng: coords.lng,
        // Pass through GarajCloud's raw state so the dashboard can read temp /
        // humidity / wind / pressure once we know their exact field names.
        state: dev.state || null,
    };
    // Best-effort rainfall — if the station doesn't have a rain sensor the
    // statistics call will return zeros (or 4xx, which fetchRainfallTotals
    // swallows into nulls). Either way, we don't fail the whole row.
    try {
        Object.assign(row, await fetchRainfallTotals(dev._id, ranges));
    } catch (e) {
        // Already handled per-window inside fetchRainfallTotals, but guard the
        // whole call just in case.
        console.warn(`[ws] rainfall fetch failed for ${dev.name}: ${e.message}`);
    }
    return row;
}

// ═══════════════════════════════════════════════════════════════
// BACKGROUND SYNC LOGIC
// ═══════════════════════════════════════════════════════════════
let isSyncing = false;

async function syncAllData() {
    if (isSyncing) return;
    isSyncing = true;
    console.log(`[${new Date().toISOString()}] Starting full data sync...`);

    try {
        const ranges = buildRanges();

        // ── Rain gauges (existing behaviour, now with lat/lng/type) ──────────
        const rainDevices = await getDevicesByType(RAIN_GAUGE_TYPE_ID);
        const rainGauges = [];
        const chunkSize = 10; // batch so we don't overwhelm GarajCloud
        for (let i = 0; i < rainDevices.length; i += chunkSize) {
            const chunk = rainDevices.slice(i, i + chunkSize);
            const rows = await Promise.all(chunk.map(d => buildRainGaugeRow(d, ranges)));
            rainGauges.push(...rows);
        }
        // Sort by highest 24h rainfall (preserved from original)
        rainGauges.sort((a, b) => (b["24h"] ?? 0) - (a["24h"] ?? 0));

        // ── Weather stations (new, best-effort) ──────────────────────────────
        let weatherStations = [];
        try {
            const wsTypeId = await discoverWeatherStationTypeId();
            if (wsTypeId) {
                const wsDevices = await getDevicesByType(wsTypeId);
                for (let i = 0; i < wsDevices.length; i += chunkSize) {
                    const chunk = wsDevices.slice(i, i + chunkSize);
                    const rows = await Promise.all(chunk.map(d => buildWeatherStationRow(d, ranges)));
                    weatherStations.push(...rows);
                }
                console.log(`[${new Date().toISOString()}] Synced ${weatherStations.length} weather stations.`);
            }
        } catch (e) {
            console.warn(`[ws-sync] non-fatal: ${e.message}`);
        }

        const finalData = {
            lastUpdated: new Date().toISOString(),
            // `devices` kept for backwards compatibility — old consumers (e.g.
            // the Cloudflare Worker) expect a flat list of rain gauges here.
            devices: rainGauges,
            // New, cleanly separated views:
            rainGauges,
            weatherStations,
        };

        fs.writeFileSync(CACHE_FILE, JSON.stringify(finalData, null, 2));
        console.log(`[${new Date().toISOString()}] Sync complete! Saved ${rainGauges.length} rain gauges, ${weatherStations.length} weather stations.`);

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

// Main endpoint for your dashboard — unchanged shape. `devices` is rain
// gauges only, just as before, so existing consumers keep working. Each
// row now includes `lat`, `lng`, and `type: 'rain_gauge'` in addition to
// the original fields.
app.get('/api', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    // Strip the new top-level fields so the response stays byte-similar to
    // the legacy version. (lat/lng/type on each device are additive and
    // harmless to old consumers.)
    res.json({ lastUpdated: data.lastUpdated, devices: data.devices || data.rainGauges || [] });
});

// New: everything in one response. Rain gauges + weather stations, each
// tagged with `type`. Use this for clients that want both.
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

// New: just weather stations.
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
// Hit these once during setup to discover what GarajCloud is returning, then
// you can leave them in (read-only, safe) or remove if you'd rather not
// expose the upstream shape publicly.

// Dump GarajCloud's device-types list so we can find the weather-station ID.
app.get('/api/debug/device-types', async (req, res) => {
    try {
        const raw = await getDeviceTypes();
        res.json({ discovered_ws_type_id: WEATHER_STATION_TYPE_ID, deviceTypes: raw });
    } catch (e) {
        res.status(500).json({ error: e.message, response: e.response?.data });
    }
});

// Dump one raw device payload (rain gauge by default; pass ?type=ws for a
// weather station) so we can see where lat/lng/state actually live.
app.get('/api/debug/device-raw', async (req, res) => {
    try {
        let typeId = RAIN_GAUGE_TYPE_ID;
        if (req.query.type === 'ws') {
            typeId = WEATHER_STATION_TYPE_ID || await discoverWeatherStationTypeId();
            if (!typeId) {
                return res.status(404).json({ error: "Weather-station device type ID not discovered yet. Hit /api/debug/device-types first." });
            }
        }
        const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
        const r = await axios.get(url, { ...axiosConfig, params: { deviceType: typeId, skip: 0, limit: 1 } });
        res.json(r.data);
    } catch (e) {
        res.status(500).json({ error: e.message, response: e.response?.data });
    }
});

// ═══════════════════════════════════════════════════════════════
// SERVER STARTUP & CRON SCHEDULE
// ═══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`Backend Server running on port ${PORT}`);

    // Schedule the sync to run automatically every 10 minutes
    cron.schedule('*/10 * * * *', () => {
        syncAllData();
    });

    // Run a sync immediately when the server boots up
    if (!fs.existsSync(CACHE_FILE)) {
        syncAllData();
    }
});
