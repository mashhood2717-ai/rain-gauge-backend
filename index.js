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

// GarajCloud deviceType ids, verified against the live fleet on 2026-08-06.
// Classifying on these instead of on the device NAME is the whole point: the
// old `/^RG/i` / `/^WS/i` name-prefix test silently discarded every device that
// didn't happen to start with those two letters, which is why the 11 "LS - ..."
// water-level sensors never appeared in any dashboard or count.
// Note rain gauges span TWO ids — filtering on one loses 43 of 134 gauges.
const DEVICE_TYPES = {
    "675b2c99e31c10760b8c792c": "rain_gauge",     // 43 gauges
    "67fd6a83336210a2d40cba16": "rain_gauge",     // 91 gauges
    "692d8807b82612c69a09b716": "weather_station", // 3 stations
    "68652d9a8cdc909a9a9326d2": "level_sensor"     // 11 water-level sensors
};
const RAIN_GAUGE_TYPE_IDS = Object.keys(DEVICE_TYPES).filter((id) => DEVICE_TYPES[id] === "rain_gauge");

// deviceType is authoritative; the name prefix is only a fallback for a device
// whose type id we haven't catalogued yet. Anything still unknown is reported
// rather than dropped — a device we can't classify is a bug to look at, not
// something to silently omit from the fleet count.
function classifyDevice(dev) {
    const rawType = typeof dev.deviceType === "object"
        ? (dev.deviceType?._id || dev.deviceType?.id)
        : dev.deviceType;
    const known = DEVICE_TYPES[rawType];
    if (known) return known;

    const name = (dev.name || "").trim();
    if (/^RG/i.test(name)) return "rain_gauge";
    if (/^WS/i.test(name)) return "weather_station";
    if (/^LS/i.test(name)) return "level_sensor";
    return "unknown";
}

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan Time (UTC+5)
const axiosConfig = { headers: { "api-key": API_KEY } };

// ═══════════════════════════════════════════════════════════════
// DEVICE / ASSET FETCH HELPERS
// ═══════════════════════════════════════════════════════════════

// Pull the ENTIRE device list, following GarajCloud's skip/limit pagination to
// exhaustion. This used to be a single `limit: 200` call, which silently
// truncates once the fleet outgrows it — a growth bug that hides new devices
// with no error anywhere.
async function getAllDevices() {
    const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
    const pageSize = 100;
    const devices = [];
    let skip = 0;
    let total = null;

    for (;;) {
        const res = await axios.get(url, {
            ...axiosConfig,
            params: { skip, limit: pageSize, returnTotal: true }
        });
        const page = res.data?.data?.devices ?? [];
        if (total === null) {
            total = res.data?.pagination?.total ?? null;
        }
        devices.push(...page);

        if (page.length < pageSize) break;
        if (total !== null && devices.length >= total) break;
        skip += pageSize;
        // Hard stop so a pagination quirk upstream can never spin forever.
        if (skip > 5000) {
            console.warn('[devices] pagination guard hit at skip=5000');
            break;
        }
    }

    if (total !== null && devices.length !== total) {
        console.warn(`[devices] fetched ${devices.length} but upstream reports total=${total}`);
    }
    return devices;
}

// Fallback path, used only if the unfiltered listing fails. Accepts several
// deviceType ids because rain gauges are NOT one type upstream — they are split
// across two (see DEVICE_TYPES), and filtering on just one silently loses the
// other 43 gauges.
async function getDevicesByType(deviceTypeIds) {
    const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
    const ids = Array.isArray(deviceTypeIds) ? deviceTypeIds : [deviceTypeIds];
    const devices = [];
    for (const deviceType of ids) {
        const res = await axios.get(url, {
            ...axiosConfig,
            params: { deviceType, skip: 0, limit: 200 }
        });
        devices.push(...(res.data?.data?.devices ?? []));
    }
    return devices;
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

// GarajCloud hard-caps every rainfall statistics query at a one-month span:
//   HTTP 400 {"message":"Date range cannot exceed 1 month"}
// That cap — not the `unit` value — is what used to make this_year and all_time
// fail. Ranges longer than a month are therefore summed from calendar-month
// slices (see monthWindows/fetchRangeTotal). `unit` only sets bucket
// granularity inside a window, so the long ranges use `day`.
//
// all_time is deliberately absent: 2010 -> now is ~200 slices per device, so at
// 133 devices it's ~26k upstream calls per sync. It needs a stored running
// total, not a live query.
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

    return {
        "24h": { unit: "hour", start: toUtc(new Date(pktNow.getTime() - 24 * 3600000)), end: toUtc(pktNow) },
        "daily": { unit: "hour", start: toUtc(todayMidnight), end: toUtc(pktNow) },
        "7d": { unit: "day", start: toUtc(new Date(todayMidnight.getTime() - 7 * 86400000)), end: toUtc(pktNow) },
        "30d": { unit: "day", start: toUtc(new Date(todayMidnight.getTime() - 30 * 86400000)), end: toUtc(pktNow) },
        "this_year": { unit: "day", start: toUtc(janFirst), end: toUtc(pktNow) }
    };
}

// Any range at or under this many days is safe to request in one shot. A "30d"
// range actually spans ~31 days once today's elapsed hours are included, so it
// takes the sliced path too rather than sitting right on the upstream cap.
const MAX_SINGLE_SPAN_DAYS = 27;

// Split [startIso, endIso] into consecutive PKT calendar-month windows. Each
// window stops 1 ms before the next month opens, so every span is strictly
// under one month and no reading is counted twice across slices.
function monthWindows(startIso, endIso) {
    const windows = [];
    const endMs = Date.parse(endIso);
    let cursor = Date.parse(startIso);

    while (cursor < endMs) {
        const pkt = new Date(cursor + PKT_OFFSET_MS);
        const monthStartMs = Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth(), 1) - PKT_OFFSET_MS;
        const nextMonthMs = Date.UTC(pkt.getUTCFullYear(), pkt.getUTCMonth() + 1, 1) - PKT_OFFSET_MS;
        const windowEndMs = nextMonthMs < endMs ? nextMonthMs - 1 : endMs;

        windows.push({
            start: new Date(cursor).toISOString(),
            end: new Date(windowEndMs).toISOString(),
            monthKey: `${pkt.getUTCFullYear()}-${String(pkt.getUTCMonth() + 1).padStart(2, "0")}`,
            // The cache key is the month itself, so only a window covering a
            // WHOLE elapsed month may be memoized. A 30d slice starting
            // mid-month must never be stored under that month's key.
            wholeElapsedMonth: cursor === monthStartMs && nextMonthMs <= endMs
        });

        cursor = nextMonthMs;
    }

    return windows;
}

// A fully elapsed calendar month's total can never change, so memoize it for
// the life of the process. Keeps this_year at one upstream call per device per
// sync once warm, instead of one call per month elapsed this year.
const _monthTotalCache = new Map();

async function fetchWindowTotal(deviceId, start, end, unit) {
    const url = `${BASE_URL}/apps/ignite-shield/external/readings/statistics/current-rainfall`;
    const res = await axios.get(url, {
        ...axiosConfig,
        params: {
            "timestamp.gte": start,
            "timestamp.lte": end,
            device: deviceId,
            unit,
            aggregationType: "Sum"
        }
    });
    const stats = res.data?.data?.statistics ?? [];
    return stats.reduce((sum, s) => sum + (s.value || 0), 0);
}

async function fetchRangeTotal(deviceId, range) {
    const spanDays = (Date.parse(range.end) - Date.parse(range.start)) / 86400000;
    if (spanDays <= MAX_SINGLE_SPAN_DAYS) {
        return fetchWindowTotal(deviceId, range.start, range.end, range.unit);
    }

    let total = 0;
    for (const win of monthWindows(range.start, range.end)) {
        const cacheKey = `${deviceId}:${win.monthKey}`;
        if (win.wholeElapsedMonth && _monthTotalCache.has(cacheKey)) {
            total += _monthTotalCache.get(cacheKey);
            continue;
        }

        const value = await fetchWindowTotal(deviceId, win.start, win.end, range.unit);
        if (win.wholeElapsedMonth) {
            _monthTotalCache.set(cacheKey, value);
        }
        total += value;
    }
    return total;
}

// ═══════════════════════════════════════════════════════════════
// PER-DEVICE FETCH HELPERS
// ═══════════════════════════════════════════════════════════════

async function fetchRainfallTotals(deviceId, ranges) {
    const out = {};
    for (const [period, range] of Object.entries(ranges)) {
        try {
            const total = await fetchRangeTotal(deviceId, range);
            out[period] = Math.round(total * 100) / 100;
        } catch (e) {
            out[period] = null;
            // Surface GarajCloud's own validation text when it sends any — bare
            // `e.message` is only ever "Request failed with status code 400",
            // which is what made the original range failures so opaque.
            out[`${period}_error`] =
                e.response?.data?.error?.metadata?.error?.[0]?.context?.message ||
                e.response?.data?.error?.message ||
                e.message;
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
        // Explicit type so consumers never have to re-guess from the name.
        // The uptime Worker and the dashboards both read this.
        type: 'rain_gauge',
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
        type: 'weather_station',
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

// Water-level sensors on Lahore drains and channels. They measure a distance to
// the water surface in feet (`Distance-ft`), plus a position and a battery
// level — no rainfall, no weather. Kept as their own type so nothing downstream
// mistakes them for gauges reporting 0 mm.
async function buildLevelSensorRow(dev) {
    const coords = await resolveCoords(dev);
    const lr = dev.lastReading || {};
    return {
        id: dev._id,
        name: dev.name,
        type: 'level_sensor',
        status: dev.state?.status,
        lat: coords.lat,
        lng: coords.lng,
        water_level_ft: readingValue(lr, 'Distance'),
        position:       readingValue(lr, 'Position'),
        battery_level:  typeof dev.state?.batteryLevel === 'number' ? dev.state.batteryLevel : null,
        last_seen:      dev.state?.lastSeen ?? null,
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

        // ── Fetch the whole fleet, then split by deviceType ─────────────────
        // Classification is by deviceType id (see DEVICE_TYPES), NOT by name
        // prefix. A device is never dropped for having an unexpected name.
        let allDevices = [];
        try {
            allDevices = await getAllDevices();
        } catch (e) {
            console.warn(`[sync] getAllDevices failed, falling back to rain-gauge types only: ${e.message}`);
            allDevices = await getDevicesByType(RAIN_GAUGE_TYPE_IDS);
        }

        const byType = { rain_gauge: [], weather_station: [], level_sensor: [], unknown: [] };
        for (const dev of allDevices) {
            byType[classifyDevice(dev)].push(dev);
        }

        if (byType.unknown.length > 0) {
            // Loud, and still included in the fleet below — an unclassifiable
            // device is a cataloguing gap to fix, not something to hide.
            console.warn(
                `[sync] ${byType.unknown.length} device(s) have an uncatalogued deviceType and are being ` +
                `reported as type "unknown": ` +
                byType.unknown.map((d) => `"${d.name}" (deviceType=${typeof d.deviceType === 'object' ? d.deviceType?._id : d.deviceType})`).join(', ')
            );
        }

        // ── Rain gauges ──────────────────────────────────────────────────────
        const rainGauges = [];
        const chunkSize = 10; // batch so we don't overwhelm GarajCloud
        for (let i = 0; i < byType.rain_gauge.length; i += chunkSize) {
            const chunk = byType.rain_gauge.slice(i, i + chunkSize);
            const rows = await Promise.all(chunk.map(d => buildRainGaugeRow(d, ranges)));
            rainGauges.push(...rows);
        }
        rainGauges.sort((a, b) => (b["24h"] ?? 0) - (a["24h"] ?? 0));

        // ── Weather stations ────────────────────────────────────────────────
        // No rainfall fetch for WS (one device returns a 32-bit overflow value
        // upstream; the other two report 0) — temp/humidity/wind/pressure
        // come straight from the device's lastReading map.
        const weatherStations = await Promise.all(byType.weather_station.map(d => buildWeatherStationRow(d)));

        // ── Water-level sensors ─────────────────────────────────────────────
        const levelSensors = await Promise.all(byType.level_sensor.map(d => buildLevelSensorRow(d)));

        // Anything we couldn't classify still ships, carrying only the fields
        // every device has, so it shows up in fleet counts and uptime tracking.
        const unknownDevices = await Promise.all(byType.unknown.map(async (dev) => {
            const coords = await resolveCoords(dev);
            return {
                id: dev._id,
                name: dev.name,
                type: 'unknown',
                status: dev.state?.status,
                lat: coords.lat,
                lng: coords.lng,
            };
        }));

        // `/api` returns the WHOLE fleet so the Cloudflare Worker (which hits
        // `/api` and writes one row per device to D1 every 15 min) tracks
        // uptime for every device. Filter on the explicit `type` field —
        // 'rain_gauge' | 'weather_station' | 'level_sensor' | 'unknown'.
        // Do NOT infer type from the name.
        const finalData = {
            lastUpdated: new Date().toISOString(),
            devices: [...rainGauges, ...weatherStations, ...levelSensors, ...unknownDevices],
            rainGauges,
            weatherStations,
            levelSensors,
            counts: {
                total: allDevices.length,
                rainGauges: rainGauges.length,
                weatherStations: weatherStations.length,
                levelSensors: levelSensors.length,
                unknown: unknownDevices.length,
            },
        };

        fs.writeFileSync(CACHE_FILE, JSON.stringify(finalData, null, 2));
        console.log(`[${new Date().toISOString()}] Sync complete! ${rainGauges.length} rain gauges, ${weatherStations.length} weather stations, ${levelSensors.length} level sensors, ${unknownDevices.length} unknown (${finalData.devices.length} of ${allDevices.length} upstream). Assets cached: ${_assetCache.size}.`);

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

// Every device class in one response, plus the fleet counts.
app.get('/api/all', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    res.json({
        lastUpdated: data.lastUpdated,
        rainGauges: data.rainGauges || data.devices || [],
        weatherStations: data.weatherStations || [],
        levelSensors: data.levelSensors || [],
        counts: data.counts || null,
    });
});

// Water-level sensors only (Lahore drains/channels — `water_level_ft`).
app.get('/api/level-sensors', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    res.json({
        lastUpdated: data.lastUpdated,
        devices: data.levelSensors || [],
    });
});

// Fleet counts on their own — cheap endpoint for dashboards that only need
// totals and shouldn't have to pull every device row to compute them.
app.get('/api/counts', (req, res) => {
    const data = readCache();
    if (!data) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    res.json({ lastUpdated: data.lastUpdated, counts: data.counts || null });
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
