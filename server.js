const fs = require("fs")
const express = require("express")
const WebSocket = require("ws")
const vehicleProgress = new Map()
let routes = {}

try {
    if (fs.existsSync("./routes.json")) {
        routes = JSON.parse(fs.readFileSync("./routes.json", "utf8")) || {}
        console.log("✅ Routes loaded from routes.json")
    } else {
        console.log("ℹ️ routes.json not found - routes will be built from live data")
    }
} catch (e) {
    console.log("⚠️ routes.json could not be loaded:", e.message)
    routes = {}
}

const app = express()
const PORT = process.env.PORT || 3000

const API = "https://api.livetransport.eu/stara-zagora"
const WS_URL = "wss://api.livetransport.eu/stara-zagora"

let stopsCache = []
let stopsById = {}
let linesById = {}
let arrivalsCache = {}
let vehiclesCache = []

let ws = null
let isWSConnected = false

const lockedVehicles = {}
const lastKnownPositions = {}
const speedCache = {}

// Cache trip data so /liveTracking does not call livetransport.eu
// on every 3-second Android refresh.
const tripCache = {}
const TRIP_CACHE_TTL = 30000

function getCachedTrip(vehicleId) {
    const cached = tripCache[vehicleId]
    if (!cached) return null
    if (Date.now() - cached.time > TRIP_CACHE_TTL) {
        delete tripCache[vehicleId]
        return null
    }
    return cached.data
}

// =======================
// TRIP CACHE
// =======================
async function getTripSafe(vehicleId) {

    const cached = getCachedTrip(vehicleId)
    if (cached) return cached

    try {

        const res = await fetch(
            `${API}/vehicle/${encodeURIComponent(vehicleId)}/trip`
        )

        if (!res.ok) {
            return null
        }

        const data = await res.json()

        tripCache[vehicleId] = {
            time: Date.now(),
            data
        }

        return data

    } catch (e) {

        console.log("Trip error:", e.message)
        return null
    }
}

// =======================
// LOAD STOPS + LINES
// =======================
async function loadStops() {
try {
const res = await fetch(`${API}/data`)
const data = await res.json()

    stopsCache = data.stops || []

    stopsById = {}
    for (const s of stopsCache) {
        stopsById[s.id] = s
    }

    // 🔥 FIX за линии
    linesById = {}
    for (const l of data.lines || []) {
        linesById[l.id] = l

        // If routes.json is missing, still expose every real line to Android.
        // Full stop sequences are filled later when a live trip is requested.
        if (!routes[l.id]) {
            routes[l.id] = {
                name: l.name || String(l.id),
                stops: [],
                shape: []
            }
        }
    }

    console.log(`✅ Loaded ${stopsCache.length} stops and ${Object.keys(linesById).length} lines`)

} catch (e) {
    console.log("Stops error")
}


}

// =======================
// QUEUE
// =======================
const requestQueue = []
const priorityQueue = []
const arrivalWaiters = new Map()
let isProcessing = false

// Normal background requests go to requestQueue.
// A stop requested by a user goes to priorityQueue so it is fetched first.
function enqueue(stopId, priority = false) {
    const queue = priority ? priorityQueue : requestQueue

    if (!queue.includes(stopId)) {
        queue.push(stopId)
    }
}

function waitForArrivals(stopId, timeoutMs = 8000) {
    return new Promise(resolve => {
        if (!arrivalWaiters.has(stopId)) {
            arrivalWaiters.set(stopId, [])
        }

        const waiters = arrivalWaiters.get(stopId)
        let settled = false

        const finish = data => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(data)
        }

        waiters.push(finish)

        const timer = setTimeout(() => {
            finish(arrivalsCache[stopId] || [])
        }, timeoutMs)
    })
}

function resolveArrivalWaiters(stopId, data) {
    const waiters = arrivalWaiters.get(stopId)
    if (!waiters) return

    arrivalWaiters.delete(stopId)
    for (const resolve of waiters) {
        resolve(data)
    }
}

async function processQueue() {
    if (isProcessing) return
    isProcessing = true

    while (true) {
        const stopId = priorityQueue.length
            ? priorityQueue.shift()
            : requestQueue.length
                ? requestQueue.shift()
                : null

        if (!stopId) {
            await delay(200)
            continue
        }

        let departures = arrivalsCache[stopId] || []

        try {
            console.log(`➡️ Fetch arrivals: ${stopId}`)
            const res = await fetch(`${API}/virtual-board/${stopId}?limit=20`)

            if (res.ok) {
                const data = await res.json()
                departures = data.departures || []
                arrivalsCache[stopId] = departures
                console.log(`✅ Fetch arrivals: ${stopId} (${departures.length})`)
            } else {
                console.log(`❌ Arrivals ${stopId}: HTTP ${res.status}`)
            }
        } catch (e) {
            console.log(`❌ Arrivals ${stopId}: ${e.message}`)
        }

        resolveArrivalWaiters(stopId, departures)

        // Keep the existing 500 ms safety gap: about 120 requests/minute
        // for the background arrivals queue, leaving headroom under the
        // upstream 180 requests/minute limit.
        await delay(500)
    }
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

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
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

app.get("/arrivals/:stopId", async (req, res) => {
    const stopId = req.params.stopId

    // If we already have data, return it immediately.
    if (arrivalsCache[stopId] !== undefined) {
        return res.json(arrivalsCache[stopId])
    }

    // Register the waiter BEFORE enqueueing. This prevents a fast upstream
    // response from being resolved before the waiter exists.
    const pending = waitForArrivals(stopId, 8000)
    console.log(`📍 Arrivals requested: ${stopId}`)
    enqueue(stopId, true)

    const departures = await pending
    console.log(`📍 Arrivals response: ${stopId} (${departures.length})`)
    return res.json(departures)
})

app.get("/vehicles", (req, res) => {
res.json(vehiclesCache)
})
app.get("/routes", (req, res) => {
    res.json(routes)
})

app.get("/routesHtml", (req, res) => {

    const htmlRoutes = {}

    for (const lineId in routes) {

        const route = routes[lineId]

        if (!route?.stops?.length) continue

        let directionKey =
            (route.stops[0]?.name || "route")
                .toLowerCase()
                .replace(/\s+/g, "_") +
            "_" +
            (route.stops[route.stops.length - 1]?.name || "route")
                .toLowerCase()
                .replace(/\s+/g, "_")

        htmlRoutes[directionKey] = route.stops.map((s, index) => {

            const lat =
                s?.geo?.coords?.[0] || 0

            const lon =
                s?.geo?.coords?.[1] || 0

            return {

    name: s.name || "Спирка",

    lat: lat,

    lon: lon,

    a: String(s.id)
}
        })
    }

    res.json(htmlRoutes)
})


// =======================
// LIVE TRACKING (FIXED)
// =======================
app.get("/liveTracking", async (req, res) => {

    const tripId = req.query.tripId
    if (!tripId) return res.json({ error: "Missing tripId" })

    try {

        let vehicleId = lockedVehicles[tripId]
        let arrivalData = null

        for (const stopId in arrivalsCache) {
            for (const a of arrivalsCache[stopId]) {
                if (a.tripId === tripId) {
                    arrivalData = a

                    if (!vehicleId && a.vehicleId) {
                        vehicleId = a.vehicleId
                        lockedVehicles[tripId] = vehicleId
                    }

                    break
                }
            }
            if (arrivalData) break
        }

        if (!vehicleId) {
            return res.json({ error: "Vehicle not found yet" })
        }

        const clean = vehicleId.split("/").pop()

        const vehicle = vehiclesCache.find(v =>
            (v[0] || "").split("/").pop() === clean
        )

        let lat, lon

        if (vehicle && vehicle[6]) {
            lat = vehicle[6][0]
            lon = vehicle[6][1]
            lastKnownPositions[vehicleId] = { lat, lon }
        } else {
            const last = lastKnownPositions[vehicleId]
            if (!last) return res.json({ error: "Vehicle position not found" })

            lat = last.lat
            lon = last.lon
        }

        const now = Date.now()
        let speed = 0

        if (speedCache[vehicleId]) {
            const prev = speedCache[vehicleId]

            const dist = distance(prev.lat, prev.lon, lat, lon)
            const time = (now - prev.time) / 1000

            speed = time > 0 ? dist / time : 0
        }

        speedCache[vehicleId] = { lat, lon, time: now }

        // ETA is calculated after we know the actual next stop.
        let eta = 0
        let etaTime = now

        const tripData = await getTripSafe(vehicleId)
console.log(JSON.stringify(tripData, null, 2))

        // =======================
        // ✅ FIX ЛИНИЯ (94 вместо 22)
        // =======================
        let rawLineId =
    tripData?.trip?.lineId ||
    arrivalData?.lineId ||
    ""

        const lineNumber =
    linesById[rawLineId]?.name || rawLineId

const destination =
    tripData?.trip?.destination?.bg ||
    tripData?.destination?.bg ||
    arrivalData?.destination?.bg ||
    "unknown"

const directionKey = `${lineNumber}_${destination}`

        // =======================
       // =======================
// ✅ SAVE ROUTE ПРАВИЛНО
// =======================
if (tripData?.trip && lineNumber) {

   const newStops =
    (tripData.trip.stops || []).map(s => {

        const full = stopsById[s.id]

        return {

            id: s.id,

            name:
                full?.name?.bg ||
                full?.name ||
                s.name ||
                "Спирка",

            geo: full?.geo,

            scheduledTime: s.scheduled || 0

        }
    })

    if (
    !routes[directionKey] ||
    !routes[directionKey].stops ||
    newStops.length > routes[directionKey].stops.length
) {

      

routes[directionKey] = {
    shape: String(tripData.trip.shape || ""),
    stops: newStops
}

        console.log("💾 ЗАПИСАНА ЛИНИЯ:", directionKey)

        fs.writeFileSync(
            "routes.json",
            JSON.stringify(routes, null, 2)
        )
    }
}



let route = routes[directionKey] || null
console.log("directionKey =", directionKey)
console.log("route first =", route?.stops?.[0]?.name)
console.log("route last =", route?.stops?.at(-1)?.name)
        // =======================
        // ✅ NEXT STOP FIX (важно)
        // =======================
        let nextStop = null
    let nextStopIndex = -1

    if (route?.stops?.length) {

        // Progress belongs to the selected trip, not only to the vehicle.
        // This prevents an old route from being reused when the same bus
        // starts another trip/line.
        const progressKey = `${vehicleId}:${tripId}`
        let progress = vehicleProgress.get(progressKey)

        // First start: choose the stop nearest to the vehicle.
        if (!progress) {

            let nearestIndex = 0
            let nearestDistance = Infinity

            for (let i = 0; i < route.stops.length; i++) {

                const stop = route.stops[i]

                if (!stop?.geo?.coords) continue

                const d = distance(
                    lat,
                    lon,
                    stop.geo.coords[0],
                    stop.geo.coords[1]
                )

                if (d < nearestDistance) {
                    nearestDistance = d
                    nearestIndex = i
                }
            }

            progress = {
                currentIndex: nearestIndex,
                reachedCurrentStop: nearestDistance <= 20
            }

        } else {

            const current = route.stops[progress.currentIndex]

            if (current?.geo?.coords) {

                const currentDistance = distance(
                    lat,
                    lon,
                    current.geo.coords[0],
                    current.geo.coords[1]
                )

                // The bus has reached the current stop.
                if (currentDistance <= 20) {
                    progress.reachedCurrentStop = true
                }

                // Only after the bus has actually reached the stop and
                // then moved more than 20 m away do we advance.
                if (
                    progress.reachedCurrentStop &&
                    currentDistance > 20 &&
                    progress.currentIndex < route.stops.length - 1
                ) {
                    progress.currentIndex++
                    progress.reachedCurrentStop = false
                }
            }
        }

        vehicleProgress.set(progressKey, progress)

        nextStopIndex = progress.currentIndex
        nextStop = route.stops[nextStopIndex]

        // Real ETA to the actual next stop.
        if (nextStop?.geo?.coords) {

            const distanceToNext = distance(
                lat,
                lon,
                nextStop.geo.coords[0],
                nextStop.geo.coords[1]
            )

            if (distanceToNext <= 20) {

                eta = 0
                etaTime = now

            } else if (speed > 0.5) {

                const etaSeconds = distanceToNext / speed
                eta = Math.max(1, Math.round(etaSeconds / 60))
                etaTime = now + Math.round(etaSeconds * 1000)

            } else {

                const scheduled = Number(nextStop.scheduledTime || 0)
                const expected = scheduled > 0
                    ? scheduled + (tripData?.delay ?? 0)
                    : 0

                if (expected > now) {
                    eta = Math.max(
                        1,
                        Math.round((expected - now) / 60000)
                    )
                    etaTime = expected
                } else {
                    eta = 0
                    etaTime = now
                }
            }
        }
    }

return res.json({
    vehicleId,
    lat,
    lon,
    eta,

    scheduledStart:
        tripData?.time?.scheduled || 0,

    actualStart:
        tripData?.time?.actual || 0,

    direction:
        tripData?.trip?.headsign ||
        tripData?.trip?.direction ||
        arrivalData?.destination?.bg ||
        "",

    nextStop: nextStop?.name || null,
    nextStopIndex,
    etaTime,

    delay: tripData?.delay ?? 0,

    lineId: lineNumber,

   stops:
    route?.stops?.length
        ? route.stops
        : (tripData?.trip?.stops || []).map(s => {

            const full = stopsById[s.id]

            return {

                id: s.id,

                name:
                    full?.name?.bg ||
                    full?.name ||
                    s.name,

                geo: full?.geo,

                scheduledTime: s.scheduled || 0
            }

        }),

    shape: route?.shape || []

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
