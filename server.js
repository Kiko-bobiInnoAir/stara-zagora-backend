const fs = require("fs")
const express = require("express")
const WebSocket = require("ws")
const vehicleProgress = new Map()
let routes = {}

try {

    routes = JSON.parse(
        fs.readFileSync("./routes.json", "utf8")
    )

    console.log("✅ Routes loaded")

} catch (e) {

    console.log("⚠️ routes.json missing")
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

// =======================
// TRIP CACHE
// =======================
async function getTripSafe(vehicleId) {

    try {

        const res = await fetch(
            `${API}/vehicle/${encodeURIComponent(vehicleId)}/trip`
        )

        if (!res.ok) {
            return null
        }

        return await res.json()

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
    }

} catch (e) {
    console.log("Stops error")
}


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

app.get("/arrivals/:stopId", (req, res) => {
const stopId = req.params.stopId


if (!arrivalsCache[stopId]) enqueue(stopId)

res.json(arrivalsCache[stopId] || [])




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

        let eta = 0

if (speed > 0.5) {
    eta = Math.max(1, Math.round(60 / speed))
}

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

if (route?.stops?.length) {

    let progress = vehicleProgress.get(vehicleId)

    // Първо стартиране
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
            currentIndex: nearestIndex
        }

    } else {

        const current = route.stops[progress.currentIndex]
        const next = route.stops[progress.currentIndex + 1]

        if (current?.geo?.coords && next?.geo?.coords) {

            const currentDistance = distance(
                lat,
                lon,
                current.geo.coords[0],
                current.geo.coords[1]
            )

            const nextDistance = distance(
                lat,
                lon,
                next.geo.coords[0],
                next.geo.coords[1]
            )

            // Минава към следващата само когато следващата вече е по-близо
            if (
                nextDistance + 150 < currentDistance &&
                progress.currentIndex < route.stops.length - 1
            ) {
                progress.currentIndex++
            }
        }
    }

    vehicleProgress.set(vehicleId, progress)

    nextStop = route.stops[progress.currentIndex]
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
