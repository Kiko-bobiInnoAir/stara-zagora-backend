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

// 🔥 намира vehicle по номер (3573)
function findVehicleSmart(foundVehicle, foundLine, tripId) {

    const target = (foundVehicle || "").split("/").pop()

    // 1️⃣ ТОЧЕН match по vehicleId
    let v = vehiclesCache.find(x => {
        const id = (x[0] || "").split("/").pop()
        return id === target
    })

    if (v) return v

    // 2️⃣ match по линия + посока (directionId = x[3])
    // tripId съдържа посоката вътре
    const direction = tripId?.split("_")[3] || null

    v = vehiclesCache.find(x => {
        return x[2] == foundLine && x[3] == direction
    })

    if (v) return v

    // 3️⃣ последен fallback – само линия
    return vehiclesCache.find(x => x[2] == foundLine) || null
}

// 🔥 изчислява ETA по GPS ако няма trip
function estimateDelayFromMovement(vehicle) {

    const delayRaw = vehicle[5] || 0
    return delayRaw // вече е в ms от API
}

// =======================
// TRIP CACHE
// =======================
const tripCache = {}
const TRIP_CACHE_TTL = 10000

async function getTrip(vehicleId) {

    const now = Date.now()

    if (
        tripCache[vehicleId] &&
        now - tripCache[vehicleId].time < TRIP_CACHE_TTL
    ) {
        return tripCache[vehicleId].data
    }

    try {
        const res = await fetch(`${API}/vehicle/${encodeURIComponent(vehicleId)}`)

        if (!res.ok) return null

        const data = await res.json()

        tripCache[vehicleId] = {
            data,
            time: now
        }

        return data

    } catch {
        return null
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

// =======================
// 🔥 LIVE TRACKING (FIXED)
// =======================
app.get("/liveTracking", async (req, res) => {

    const tripId = req.query.tripId
    if (!tripId) return res.json({ error: "Missing tripId" })

    try {

        let foundVehicle = null
        let foundLine = null

        // 🔍 намираме от arrivals
        for (const stopId in arrivalsCache) {
            for (const a of arrivalsCache[stopId]) {
                if (a.tripId === tripId) {
                    foundVehicle = a.vehicleId || null
                    foundLine = a.lineId
                    break
                }
            }
            if (foundLine) break
        }

        // 🔥 ако няма vehicle → пак работим по линия
       const vehicle = findVehicleSmart(foundVehicle, foundLine, tripId)

        if (!vehicle) {
            return res.json({ error: "No vehicle for this line" })
        }

        const coords = vehicle[6] || [0, 0]

        // 🔥 ползваме РЕАЛНИЯ vehicleId от WS
        const realVehicleId = vehicle[0]

        const tripData = await getTrip(realVehicleId)

        let nextStop = 0
        let delay = 0
        let stops = []
        let shape = ""

        if (tripData) {
            nextStop = tripData.nextStop || 0
            delay = tripData.delay || 0
            stops = tripData.trip?.stops || []
            shape = tripData.trip?.shape || ""
        } else {
            // 🔥 fallback ETA от движение
            delay = estimateDelayFromMovement(vehicle)
        }

        return res.json({
            vehicleId: realVehicleId,
            lineId: foundLine,
            lat: coords[0],
            lon: coords[1],
            nextStop,
            delay,
            stops,
            shape
        })

    } catch (e) {
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
