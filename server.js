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

        await delay(350) // ⚠️ пазим лимита
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

// =======================
// TRIP CACHE (safe)
// =======================
const tripCache = {}
const tripLastRequest = {}
const TRIP_CACHE_TTL = 10000
const MIN_TRIP_INTERVAL = 5000

async function getTrip(vehicleId) {

    const now = Date.now()

    if (
        tripCache[vehicleId] &&
        now - tripCache[vehicleId].time < TRIP_CACHE_TTL
    ) {
        return tripCache[vehicleId].data
    }

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
// API
// =======================
app.get("/", (req, res) => {
    res.send("Backend running")
})

app.get("/stops", (req, res) => {
    res.json(stopsCache)
})

app.get("/arrivals/:stopId", (req, res) => {
    const stopId = req.params.stopId

    if (!arrivalsCache[stopId]) enqueue(stopId)

    res.json(arrivalsCache[stopId] || [])
})

app.get("/vehicles", (req, res) => {
    res.json(vehiclesCache)
})


//////
function calculateETA(tripData) {

    if (!tripData?.trip?.stops?.length) return null

    const nextIndex = tripData.nextStop || 0
    const nextStop = tripData.trip.stops[nextIndex]

    if (!nextStop?.scheduled) return null

    const now = Date.now()

    const arrival = nextStop.scheduled + (tripData.delay || 0)

    const diff = arrival - now

    if (diff <= 0) return 0

    return Math.round(diff / 60000)
}



// =======================
// LIVE TRACKING
// =======================
app.get("/liveTracking", async (req, res) => {

    const tripId = req.query.tripId

    if (!tripId) {
        return res.json({ error: "Missing tripId" })
    }

    try {

        let vehicleId = lockedVehicles[tripId]

        // 🔒 LOCK
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

        // =======================
        // GPS
        // =======================
        const clean = vehicleId.split("/").pop()

        const vehicle = vehiclesCache.find(v =>
            (v[0] || "").split("/").pop() === clean
        )

        let lat, lon

        if (vehicle) {
            const coords = vehicle[6] || [0, 0]

            lat = coords[0]
            lon = coords[1]

            lastKnownPositions[vehicleId] = { lat, lon }

        } else {

            const last = lastKnownPositions[vehicleId]

            if (!last) {
                return res.json({ error: "Vehicle position not found" })
            }

            lat = last.lat
            lon = last.lon
        }

        // =======================
        // TRIP (истински ETA)
        // =======================
        const tripData = await getTrip(vehicleId)

        let eta = null

        if (tripData) {
            eta = calculateETA(tripData)
        }

        // =======================
        // FALLBACK GPS ETA
        // =======================
        if (eta === null) {

            const now = Date.now()
            let speed = 0

            if (speedCache[vehicleId]) {
                const prev = speedCache[vehicleId]

                const dist = distance(prev.lat, prev.lon, lat, lon)
                const time = (now - prev.time) / 1000

                speed = time > 0 ? dist / time : 0
            }

            speedCache[vehicleId] = {
                lat,
                lon,
                time: now
            }

            if (speed > 1) {
                eta = Math.round(60 / speed)
            }
        }

        lastKnownPositions[vehicleId].eta = eta

        return res.json({
            vehicleId,
            lat,
            lon,
            eta,
            nextStop: tripData?.nextStop ?? null,
            delay: tripData?.delay ?? 0
        })

    } catch (e) {
        console.log("Live error:", e.message)
        res.json({ error: "Internal error" })
    }
})
        // =======================
        // SPEED + ETA
        // =======================
        const now = Date.now()

        let speed = 0

        if (speedCache[vehicleId]) {
            const prev = speedCache[vehicleId]

            const dist = distance(prev.lat, prev.lon, coords[0], coords[1])
            const time = (now - prev.time) / 1000

            speed = time > 0 ? dist / time : 0
        }

        speedCache[vehicleId] = {
            lat: coords[0],
            lon: coords[1],
            time: now
        }

        let eta = null

        if (speed > 1) {
            eta = Math.round(60 / speed) // груб ETA
        }

        lastKnownPositions[vehicleId].eta = eta

        const tripData = await getTrip(vehicleId)

        return res.json({
            vehicleId,
            lat: coords[0],
            lon: coords[1],
            eta,
            nextStop: tripData?.nextStop ?? null
        })

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