const express = require("express")
const WebSocket = require("ws")

const app = express()
const PORT = process.env.PORT || 3000

const API = "https://api.livetransport.eu/stara-zagora"
const WS_URL = "wss://api.livetransport.eu/stara-zagora"

let stopsCache = []
let arrivalsCache = {}
let vehiclesCache = []

let ws = null
let isWSConnected = false

const lockedVehicles = {}
const lastKnownPositions = {}
const speedCache = {}
const smoothCache = {}

// =======================
// FETCH
// =======================
const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

function delay(ms) {
    return new Promise(res => setTimeout(res, ms))
}

// =======================
// QUEUE
// =======================
const requestQueue = []
let isProcessing = false

function enqueue(stopId) {
    if (!requestQueue.includes(stopId)) {
        requestQueue.push(stopId)
    }
}

async function processQueue() {
    if (isProcessing) return
    isProcessing = true

    while (true) {
        if (!requestQueue.length) {
            await delay(200)
            continue
        }

        const stopId = requestQueue.shift()

        try {
            const res = await fetch(`${API}/virtual-board/${stopId}?limit=20`)
            if (res.ok) {
                const data = await res.json()
                arrivalsCache[stopId] = data.departures || []
            }
        } catch {}

        await delay(350)
    }
}

// =======================
// СПИРКИ
// =======================
async function loadStops() {
    try {
        const res = await fetch(`${API}/data`)
        const data = await res.json()
        stopsCache = data.stops || []
    } catch {}
}

// =======================
// ARRIVALS
// =======================
let currentIndex = 0
const BATCH_SIZE = 10

async function loadArrivals() {
    if (!stopsCache.length) return

    const batch = stopsCache.slice(currentIndex, currentIndex + BATCH_SIZE)
    for (const stop of batch) enqueue(stop.id)

    currentIndex += BATCH_SIZE
    if (currentIndex >= stopsCache.length) currentIndex = 0
}

// =======================
// WS GPS
// =======================
function connectWS() {
    if (isWSConnected) return

    ws = new WebSocket(WS_URL)

    ws.on("open", () => {
        isWSConnected = true
    })

    ws.on("message", (msg) => {
        try {
            vehiclesCache = JSON.parse(msg)
        } catch {}
    })

    ws.on("close", () => {
        isWSConnected = false
        setTimeout(connectWS, 3000)
    })

    ws.on("error", () => {
        isWSConnected = false
        ws.close()
    })
}

// =======================
// HELPERS
// =======================
function distance(lat1, lon1, lat2, lon2) {
    const R = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) *
        Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2

    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function lerp(a, b, t) {
    return a + (b - a) * t
}

function decodePolyline(str) {
    let index = 0, lat = 0, lng = 0
    const coordinates = []

    while (index < str.length) {
        let b, shift = 0, result = 0

        do {
            b = str.charCodeAt(index++) - 63
            result |= (b & 0x1f) << shift
            shift += 5
        } while (b >= 0x20)

        lat += (result & 1) ? ~(result >> 1) : (result >> 1)

        shift = result = 0

        do {
            b = str.charCodeAt(index++) - 63
            result |= (b & 0x1f) << shift
            shift += 5
        } while (b >= 0x20)

        lng += (result & 1) ? ~(result >> 1) : (result >> 1)

        coordinates.push([lat / 1e5, lng / 1e5])
    }

    return coordinates
}

// =======================
// TRIP CACHE
// =======================
const tripCache = {}
const TRIP_CACHE_TTL = 10000
const tripLastRequest = {}
const MIN_TRIP_INTERVAL = 5000 // 5 сек

async function getTrip(vehicleId) {

    const now = Date.now()

    // ✅ кеш
    if (
        tripCache[vehicleId] &&
        now - tripCache[vehicleId].time < TRIP_CACHE_TTL
    ) {
        return tripCache[vehicleId].data
    }

    // 🚫 rate limit защита
    if (
        tripLastRequest[vehicleId] &&
        now - tripLastRequest[vehicleId] < MIN_TRIP_INTERVAL
    ) {
        return tripCache[vehicleId]?.data || null
    }

    try {
        tripLastRequest[vehicleId] = now

        const res = await fetch(`${API}/vehicle/${encodeURIComponent(vehicleId)}`)

        if (!res.ok) return tripCache[vehicleId]?.data || null

        const data = await res.json()

        tripCache[vehicleId] = {
            data,
            time: now
        }

        return data

    } catch {
        return tripCache[vehicleId]?.data || null
    }
}
// =======================
// LIVE TRACKING
// =======================
app.get("/liveTracking", async (req, res) => {

    const tripId = req.query.tripId
    if (!tripId) return res.json({ error: "Missing tripId" })

    try {

        let vehicleId = lockedVehicles[tripId]

        if (!vehicleId) {
            for (const stopId in arrivalsCache) {
                for (const a of arrivalsCache[stopId]) {
                    if (a.tripId === tripId && a.vehicleId) {
                        vehicleId = a.vehicleId
                        lockedVehicles[tripId] = vehicleId
                        break
                    }
                }
                if (vehicleId) break
            }
        }

        if (!vehicleId) {
            return res.json({ error: "Vehicle not found yet" })
        }

        const clean = vehicleId.split("/").pop()

        let vehicle = vehiclesCache.find(v =>
            (v[0] || "").split("/").pop() === clean
        )

        // fallback ако изчезне
        if (!vehicle) {
            const last = lastKnownPositions[vehicleId]
            if (last) return res.json(last)
            return res.json({ error: "Vehicle position not found" })
        }

        const coords = vehicle[6] || [0, 0]

        // =======================
        // SMOOTH
        // =======================
        let lat = coords[0]
        let lon = coords[1]

        if (smoothCache[vehicleId]) {
            const prev = smoothCache[vehicleId]
            lat = lerp(prev.lat, coords[0], 0.3)
            lon = lerp(prev.lon, coords[1], 0.3)
        }

        smoothCache[vehicleId] = { lat, lon }

        // =======================
        // SPEED
        // =======================
        const now = Date.now()

        if (speedCache[vehicleId]) {
            const prev = speedCache[vehicleId]
            const dist = distance(prev.lat, prev.lon, lat, lon)
            const time = (now - prev.time) / 1000
            const speed = time > 0 ? dist / time : 0

            speedCache[vehicleId] = { lat, lon, time: now, speed }
        } else {
            speedCache[vehicleId] = { lat, lon, time: now, speed: 0 }
        }

        const speed = speedCache[vehicleId].speed

        // =======================
        // TRIP + ETA
        // =======================
        const tripData = await getTrip(vehicleId)

        let eta = null

        if (tripData?.trip?.stops?.length && speed > 1) {
            const next = tripData.trip.stops[tripData.nextStop || 0]

            if (next?.lat) {
                const dist = distance(lat, lon, next.lat, next.lon)
                eta = Math.round((dist / speed) / 60)
            }
        }

        if (!eta && speed > 1) eta = 1

        // =======================
        // SHAPE
        // =======================
        let shape = []
        if (tripData?.trip?.shape) {
            shape = decodePolyline(tripData.trip.shape)
        }

        const response = {
            vehicleId,
            lat,
            lon,
            eta,
            nextStop: tripData?.nextStop ?? null,
            delay: tripData?.delay ?? 0,
            shape
        }

        lastKnownPositions[vehicleId] = response

        return res.json(response)

    } catch (e) {
        console.log("Live error:", e.message)
        res.json({ error: "Internal error" })
    }
})

// =======================
// START
// =======================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT)
})

async function startServer() {
    await loadStops()

    for (let i = 0; i < Math.min(stopsCache.length, 50); i++) {
        enqueue(stopsCache[i].id)
    }

    processQueue()
    connectWS()

    setInterval(loadArrivals, 5000)
    setInterval(loadStops, 5 * 60 * 1000)
}

startServer()