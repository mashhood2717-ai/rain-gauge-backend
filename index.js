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
const DEVICE_TYPE_ID = "67fd6a83336210a2d40cba16";
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan Time (UTC+5)

const axiosConfig = { headers: { "api-key": API_KEY } };

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════
async function getDevices() {
    const url = `${BASE_URL}/apps/ignite-shield/external/devices`;
    const res = await axios.get(url, { ...axiosConfig, params: { deviceType: DEVICE_TYPE_ID, skip: 0, limit: 100 } });
    return res.data?.data?.devices ?? [];
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
        "7d": { unit: "day", start: toUtc(new Date(todayMidnight.getTime() - 7 * 86400000)), end: toUtc(todayMidnight) },
        "30d": { unit: "day", start: toUtc(new Date(todayMidnight.getTime() - 30 * 86400000)), end: toUtc(todayMidnight) },
        "this_year": { unit: "month", start: toUtc(janFirst), end: toUtc(todayMidnight) },
        "all_time": { unit: "month", start: installationDate.toISOString(), end: toUtc(pktNow) }
    };
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
        const devices = await getDevices();
        const ranges = buildRanges();
        const results = [];

        // Fetch in batches of 10 to not overwhelm the Dynasys API
        const chunkSize = 10;
        for (let i = 0; i < devices.length; i += chunkSize) {
            const chunk = devices.slice(i, i + chunkSize);
            
            const promises = chunk.map(async (dev) => {
                const row = { id: dev._id, name: dev.name, status: dev.state?.status };
                
                for (const [period, range] of Object.entries(ranges)) {
                    try {
                        const url = `${BASE_URL}/apps/ignite-shield/external/readings/statistics/current-rainfall`;
                        const res = await axios.get(url, {
                            ...axiosConfig,
                            params: {
                                "timestamp.gte": range.start,
                                "timestamp.lte": range.end,
                                device: dev._id,
                                unit: range.unit,
                                aggregationType: "Sum"
                            }
                        });
                        
                        const stats = res.data?.data?.statistics ?? [];
                        const total = stats.reduce((sum, s) => sum + (s.value || 0), 0);
                        row[period] = Math.round(total * 100) / 100;
                    } catch (e) {
                        row[period] = null;
                        row[`${period}_error`] = e.message;
                    }
                }
                return row;
            });

            const chunkResults = await Promise.all(promises);
            results.push(...chunkResults);
        }

        // Sort by highest 24h rainfall
        results.sort((a, b) => (b["24h"] ?? 0) - (a["24h"] ?? 0));

        const finalData = {
            lastUpdated: new Date().toISOString(),
            devices: results
        };

        // Write to local disk cache
        fs.writeFileSync(CACHE_FILE, JSON.stringify(finalData, null, 2));
        console.log(`[${new Date().toISOString()}] Sync complete! Saved 87 devices.`);

    } catch (e) {
        console.error("Critical error during sync:", e.message);
    } finally {
        isSyncing = false;
    }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

// Lightweight endpoint just to keep the server awake (use this for cron-job.org)
app.get('/ping', (req, res) => {
    res.send('ok');
});

// Main endpoint for your dashboard
app.get('/api', (req, res) => {
    if (!fs.existsSync(CACHE_FILE)) {
        return res.status(503).json({ error: "Server just booted up. Fetching data for the first time, please refresh in 2 minutes." });
    }
    const data = JSON.parse(fs.readFileSync(CACHE_FILE));
    res.json(data);
});

// Force sync endpoint for testing
app.get('/force-sync', (req, res) => {
    syncAllData(); // run in background
    res.json({ message: "Background sync triggered." });
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
