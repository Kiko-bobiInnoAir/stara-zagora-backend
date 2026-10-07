process.env.PUPPETEER_CACHE_DIR = "./.puppeteer-cache"

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
        const parsed = JSON.parse(msg)

        if (Array.isArray(parsed)) {
            vehiclesCache = parsed
        } else if (Array.isArray(parsed?.data)) {
            vehiclesCache = parsed.data
        } else if (Array.isArray(parsed?.vehicles)) {
            vehiclesCache = parsed.vehicles
        } else {
            vehiclesCache = Object.values(parsed || {})
                .filter(v => Array.isArray(v))
        }

    } catch (e) {
        console.log("WS parse error:", e.message)
    }
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
    const requestedVehicleId = req.query.vehicleId

    if (!tripId && !requestedVehicleId) {
        return res.json({
            error: "Missing tripId or vehicleId"
        })
    }

    try {

        let vehicleId =
            requestedVehicleId ||
            lockedVehicles[tripId]

        let arrivalData = null

        // ==========================================
        // 🔥 ако е избрано превозно средство
        // директно го намираме по vehicle ID
        // ==========================================

        if (!vehicleId) {

            for (const stopId in arrivalsCache) {

                for (const a of arrivalsCache[stopId]) {

                    if (
                        a.vehicleId &&
                        a.vehicleId.split("/").pop() ===
                        requestedVehicleId
                    ) {

                        arrivalData = a

                        vehicleId = a.vehicleId

                        break
                    }
                }

                if (vehicleId) break
            }
        }

        // ==========================================
        // старият механизъм по tripId остава
        // ==========================================

        if (!vehicleId && tripId) {

            for (const stopId in arrivalsCache) {

                for (const a of arrivalsCache[stopId]) {

                    if (a.tripId === tripId) {

                        arrivalData = a

                        if (a.vehicleId) {

                            vehicleId = a.vehicleId

                            lockedVehicles[tripId] =
                                vehicleId
                        }

                        break
                    }
                }

                if (arrivalData) break
            }
        }

        if (!vehicleId) {

            return res.json({
                error: "Vehicle not found yet"
            })
        }

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

        const vehicleList = Array.isArray(vehiclesCache)
    ? vehiclesCache
    : Object.values(vehiclesCache || {})

const vehicle = vehicleList.find(v => {
    if (!Array.isArray(v)) return false

    return String(v[0] || "")
        .split("/")
        .pop() === clean
})

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
// BDZ TRAIN STATION
// =======================

const TRAIN_REFRESH_MS = 60 * 1000

let trainStationCache = {
    updatedAt: 0,
    nextUpdateAt: 0,
    departures: [],
    arrivals: [],
    lastError: null
}

let trainBrowser = null
let trainUpdateRunning = false

function parseBDZBoardText(text) {

    const lines = text
        .split(/\r?\n/)
        .map(v => v.trim())
        .filter(Boolean)

    const trains = []

    const timeRegex = /^\d{1,2}:\d{2}$/
    const trainRegex = /^(МБВ|БВ|ПВ|КПВ)\s+\d+$/

    let consumedTimeIndex = -1

    for (let i = 0; i < lines.length; i++) {

        /*
         * Ако този час вече е използван като
         * НОВ ПЛАНИРАН ЧАС на предишния влак,
         * не го обработваме отново като нов влак.
         */
        if (i <= consumedTimeIndex) {
            continue
        }

        const plannedTime = lines[i]

        if (!timeRegex.test(plannedTime)) {
            continue
        }

        /*
         * По подразбиране няма нов планиран час.
         */
        let newPlannedTime = ""

        /*
         * Започваме да четем данните след първия час.
         */
        let startIndex = i + 1

        /*
         * АКО СЛЕД ПЛАНИРАНИЯ ЧАС ИМА ВТОРИ ЧАС:
         *
         * 02:09
         * 02:12
         * ВАРНА
         * БВ 8657
         * 4
         * Закъснение 3 мин.
         *
         * тогава:
         *
         * plannedTime    = 02:09
         * newPlannedTime = 02:12
         *
         * 02:12 НЕ е текущ час.
         */
        if (
            i + 1 < lines.length &&
            timeRegex.test(lines[i + 1])
        ) {

            newPlannedTime = lines[i + 1]

            /*
             * Запомняме, че този втори час вече
             * е използван и не трябва да стане
             * начало на нов влак.
             */
            consumedTimeIndex = i + 1

            startIndex = i + 2
        }

        /*
         * Събираме данните за конкретния влак.
         */
        const values = []

        for (
            let j = startIndex;
            j < lines.length && values.length < 15;
            j++
        ) {

            const value = lines[j]

            /*
             * Следващият час означава начало
             * на следващ влак.
             */
            if (timeRegex.test(value)) {
                break
            }

            const lower = value.toLowerCase()

            /*
             * Премахваме елементи от самото табло,
             * които не са данни за влака.
             */
            if (
                lower === "заминаващи" ||
                lower === "пристигащи" ||
                lower === "електронно табло" ||
                lower === "стара загора" ||
                lower === "live"
            ) {
                continue
            }

            if (value === "*") {
                continue
            }

            values.push(value)
        }

        /*
         * Търсим номера на влака.
         */
        const trainIndex = values.findIndex(
            value => trainRegex.test(value)
        )

        if (trainIndex === -1) {
            continue
        }

        const trainNumber = values[trainIndex]

        /*
         * ДЕСТИНАЦИЯ
         *
         * Обикновено е непосредствено преди
         * номера на влака.
         *
         * Например:
         *
         * ВАРНА
         * БВ 8657
         */
        let destination = ""

        for (let j = trainIndex - 1; j >= 0; j--) {

            const value = values[j]

            if (!value) {
                continue
            }

            if (
                value.toLowerCase().includes("закъснение")
            ) {
                continue
            }

            if (
                /^коловоз\s+\d{1,2}$/i.test(value)
            ) {
                continue
            }

            if (
                /^\d{1,2}$/.test(value)
            ) {
                continue
            }

            destination = value
            break
        }

        /*
         * КОЛОВОЗ
         *
         * БДЖ може да върне:
         *
         * Коловоз 4
         *
         * или само:
         *
         * 4
         */
        let platform = ""

        for (
            let j = trainIndex + 1;
            j < values.length;
            j++
        ) {

            const value = values[j]

            if (
                /^коловоз\s+\d{1,2}$/i.test(value)
            ) {

                platform = value
                break
            }

            if (
                /^\d{1,2}$/.test(value)
            ) {

                platform = `Коловоз ${value}`
                break
            }
        }

        /*
         * ЗАКЪСНЕНИЕ
         */
        let delay = ""

        const delayValue = values.find(value =>
            value.toLowerCase().includes("закъснение")
        )

        if (delayValue) {

            const match =
                delayValue.match(/(\d+)\s*мин,закъснение/i)

            if (match) {

                delay = `${match[1]} мин.`

            } else {

                delay = delayValue
            }
        }

        /*
         * ВАЖНО:
         *
         * "time" оставяме като първоначалния
         * планиран час, за да не счупим
         * съществуващия Android код.
         *
         * "newPlannedTime" е новият планиран час
         * след закъснението.
         */
        trains.push({

            time: plannedTime,

            plannedTime: plannedTime,

            newPlannedTime: newPlannedTime,

            destination: destination,

            trainNumber: trainNumber,

            platform: platform,

            delay: delay
        })
    }

    /*
     * Премахваме евентуални дублирани влакове.
     */
    return trains.filter((train, index, array) =>

        index === array.findIndex(other =>

            other.plannedTime === train.plannedTime &&

            other.newPlannedTime === train.newPlannedTime &&

            other.trainNumber === train.trainNumber &&

            other.destination === train.destination
        )
    )
}
async function getBDZBoard(page, type) {

    const url =
        `https://live.bdz.bg/bg/stara-zagora/${type}`

    await page.goto(
        url,
        {
            waitUntil: "networkidle2",
            timeout: 30000
        }
    )

    await new Promise(resolve =>
        setTimeout(resolve, 1500)
    )

    const trains = await page.evaluate(() => {

        const items =
            Array.from(
                document.querySelectorAll(
                    ".timetableItem[data-train]"
                )
            )

        return items.map(item => {

            const trainNumber =
                item.getAttribute("data-train") || ""

            const delayValue =
                parseInt(
                    item.getAttribute("data-delay") || "0",
                    10
                )

            // ЧАСОВЕТЕ
            const timeCell =
                item.querySelector(
                    ".col-3.col-lg-2"
                )

            const timeText =
                timeCell
                    ? (timeCell.innerText || "")
                        .trim()
                        .replace(/\s+/g, " ")
                    : ""

            const times =
                timeText.match(/\b\d{1,2}:\d{2}\b/g) || []

            let plannedTime = ""
            let newPlannedTime = ""

            const oldTimeElement =
                timeCell
                    ? timeCell.querySelector("s")
                    : null

            if (oldTimeElement) {

                plannedTime =
                    (oldTimeElement.innerText || "")
                        .trim()

                const remainingTimes =
                    times.filter(
                        time => time !== plannedTime
                    )

                if (remainingTimes.length > 0) {
                    newPlannedTime =
                        remainingTimes[0]
                }

            } else {

                if (times.length > 0) {
                    plannedTime = times[0]
                }

            }

            // ДЕСТИНАЦИЯ
            const destinationElement =
                item.querySelector(
                    ".col-9.col-lg-7 .col-12.col-lg-6 strong"
                )

            const destination =
                destinationElement
                    ? (destinationElement.innerText || "")
                        .trim()
                    : ""

            // ВЛАК
            const trainElement =
                item.querySelector(
                    '[data-original-title]'
                )

            const trainNumberText =
                trainElement
                    ? (trainElement.innerText || "")
                        .trim()
                        .replace(/\s+/g, " ")
                    : ""

            // КОЛОВОЗ
            const platformElement =
                item.querySelector(
                    '[data-station-id]'
                )

            let platform = ""

            if (platformElement) {

                platform =
                    (platformElement.innerText || "")
                        .trim()
                        .replace(/\s+/g, " ")

                platform =
                    platform
                        .replace(
                            /^Коловоз\s*/i,
                            ""
                        )
                        .trim()
            }

            // ЗАКЪСНЕНИЕ
            const delay =
                delayValue > 0
                    ? `${delayValue} мин. закъснение`
                    : ""

            return {

                plannedTime,

                newPlannedTime,

                destination,

                trainNumber:
                    trainNumberText || trainNumber,

                platform:
                    platform
                        ? `Коловоз ${platform}`
                        : "",

                delay,

                // Съвместимост със сегашния Android
                time:
                    newPlannedTime || plannedTime
            }

        }).filter(train =>
            train.plannedTime &&
            train.destination &&
            train.trainNumber
        )
    })

    return trains
}

async function updateTrainStationCache() {

    if (trainUpdateRunning) {
        return
    }

    trainUpdateRunning = true

    try {

        if (!trainBrowser) {

            const puppeteer =
                require("puppeteer")

          trainBrowser = await puppeteer.launch({
    headless: true,
    args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
    ]
});
        }

        const page =
            await trainBrowser.newPage()

        await page.setViewport({
            width: 1280,
            height: 1200
        })

        const departures =
            await getBDZBoard(
                page,
                "departures"
            )

        const arrivals =
            await getBDZBoard(
                page,
                "arrivals"
            )

        await page.close()

        const now =
            Date.now()

        trainStationCache = {
            updatedAt: now,
            nextUpdateAt:
                now + TRAIN_REFRESH_MS,
            departures,
            arrivals,
            lastError: null
        }

        console.log(
            `🚆 BDZ updated: ${departures.length} departures, ${arrivals.length} arrivals`
        )

    } catch (e) {

        console.log(
            "🚆 BDZ error:",
            e.message
        )

        trainStationCache.lastError =
            e.message

        trainStationCache.nextUpdateAt =
            Date.now() + TRAIN_REFRESH_MS

    } finally {

        trainUpdateRunning = false
    }
}

app.get("/trainStation", (req, res) => {

    res.json({
        updatedAt:
            trainStationCache.updatedAt,

        nextUpdateAt:
            trainStationCache.nextUpdateAt,

        departures:
            trainStationCache.departures,

        arrivals:
            trainStationCache.arrivals,

        error:
            trainStationCache.lastError || null
    })
})

// Първоначално зареждане
updateTrainStationCache()

// Обновяване на всеки 60 секунди
setInterval(
    updateTrainStationCache,
    TRAIN_REFRESH_MS
)

// END BDZ TRAIN STATION


// =======================
// BUS STATION - STARA ZAGORA
// =======================

const BUS_REFRESH_MS = 60 * 1000

let busStationCache = {
    departures: [],
    arrivals: [],
    updatedAt: 0,
    nextUpdateAt: 0,
    lastError: ""
}

let busRefreshRunning = false


function parseBusStationText(text) {

    const lines = text
        .split(/\r?\n/)
        .map(v => v.trim())
        .filter(Boolean)

    const buses = []

    const timeRegex = /^\d{1,2}:\d{2}$/
    const rangeRegex = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/

    for (let i = 0; i < lines.length; i++) {

        if (lines[i].toLowerCase() !== "час") {
            continue
        }

        const time = lines[i + 1]

        if (!time || !timeRegex.test(time)) {
            continue
        }

        const block = []

        let j = i + 2

        while (
            j < lines.length &&
            lines[j].toLowerCase() !== "час"
        ) {
            block.push(lines[j])
            j++
        }

        const titleIndex = block.findIndex(value =>
            /^СТАРА ЗАГОРА\s*-\s*/i.test(value)
        )

        if (titleIndex === -1) {
            continue
        }

        const title = block[titleIndex]

        const destination = title
            .replace(/^СТАРА ЗАГОРА\s*-\s*/i, "")
            .trim()

        const operator =
            block[titleIndex + 1] || ""

        const days =
            block.find(value =>
                /^(Пн|Вт|Ср|Чт|Пт|Сб|Нд)(,\s*(Пн|Вт|Ср|Чт|Пт|Сб|Нд))*$/i
                    .test(value)
            ) || ""

        const sector =
            block.find(value =>
                /^Сектор\s*:/i.test(value)
            ) || ""

        const price =
            block.find(value =>
                /€.*лв\./i.test(value)
            ) || ""

        const routeTimes =
            block.filter(value =>
                rangeRegex.test(value)
            )

        const route = []

        let currentRange = null

        for (let k = 0; k < block.length; k++) {

            const value = block[k]

            if (rangeRegex.test(value)) {
                currentRange = value
                continue
            }

            if (!currentRange) {
                continue
            }

            if (
                value === "*" ||
                value === "* * *"
            ) {
                continue
            }

            const nextValue = block[k + 1]

            if (
                nextValue &&
                !rangeRegex.test(nextValue) &&
                nextValue !== "*"
            ) {

                route.push({
                    time: currentRange,
                    from: value,
                    to: nextValue
                })

                currentRange = null
                k++
            }
        }

        buses.push({
            time,
            destination,
            operator,
            days,
            sector,
            price,
            route
        })

        i = j - 1
    }

    return buses
        .filter((bus, index, array) =>
            index === array.findIndex(other =>
                other.time === bus.time &&
                other.destination === bus.destination &&
                other.operator === bus.operator
            )
        )
}

let busBrowser = null

async function getBusBrowser() {

    if (busBrowser) {
        return busBrowser
    }

    const puppeteer = require("puppeteer")

    busBrowser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"
        ]
    })

    return busBrowser
}

async function scrapeBusStation() {

    const browser = await getBusBrowser()
    const page = await browser.newPage()

    try {

        await page.setUserAgent(
            "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/130 Safari/537.36"
        )

        await page.setViewport({
            width: 1280,
            height: 1600
        })

        await page.goto(
            "https://avtogara.starazagora.bg/bg/busstations/",
            {
                waitUntil: "networkidle2",
                timeout: 30000
            }
        )

        await new Promise(resolve =>
            setTimeout(resolve, 1500)
        )

        const text =
            await page.evaluate(() =>
                document.body.innerText || ""
            )

        return parseBusStationText(text)

    } finally {

        await page.close()

    }
}


async function refreshBusStation() {

    if (busRefreshRunning) {
        return
    }

    busRefreshRunning = true

    try {

        const departures =
            await scrapeBusStation()

        const now = Date.now()

        busStationCache = {
            departures,
            arrivals: [],
            updatedAt: now,
            nextUpdateAt:
                now + BUS_REFRESH_MS,
            lastError: ""
        }

        console.log(
            `🚌 Bus station updated: ${departures.length} departures`
        )

    } catch (e) {

        console.log(
            "🚌 Bus station refresh error:",
            e.message
        )

        busStationCache.lastError =
            e.message

        busStationCache.nextUpdateAt =
            Date.now() + BUS_REFRESH_MS

    } finally {

        busRefreshRunning = false

    }
}


app.get("/busStation", (req, res) => {

    res.json({
        updatedAt:
            busStationCache.updatedAt,

        nextUpdateAt:
            busStationCache.nextUpdateAt,

        departures:
            busStationCache.departures,

        arrivals:
            busStationCache.arrivals,

        error:
            busStationCache.lastError || null
    })

})

// =======================
// END BUS STATION
// =======================


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



// Автогара
refreshBusStation()
setInterval(refreshBusStation, BUS_REFRESH_MS)
    

setInterval(loadArrivals, 5000)
setInterval(loadStops, 5 * 60 * 1000)


}

startServer()

