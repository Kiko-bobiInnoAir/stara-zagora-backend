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
// FETCH FIX
// =======================
const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

function delay(ms) {
    return new Promise(res => setTimeout(res, ms))
}

// =======================
// QUEUE (за да НЕ банва)
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
                console.log("Updated:", stopId)
            } else {
                console.log("Rate limited:", stopId)
            }

        } catch (e) {
            console.log("Error:", stopId)
        }

        await delay(350) // ~3 заявки/сек (в лимита)
    }
}

// =======================
// СПИРКИ
// =======================
async function loadStops() {
    try {
        const res = await fetch(`${API}/data`)
        const text = await res.text()

        if (!text.startsWith("{")) {
            console.log("Invalid stops response:", text)
            return
        }

        const data = JSON.parse(text)
        stopsCache = data.stops || []

        console.log("Stops:", stopsCache.length)

    } catch (e) {
        console.log("Stops error:", e.message)
    }
}

// =======================
// ARRIVALS (batch)
// =======================
let currentIndex = 0
const BATCH_SIZE = 10

async function loadArrivals() {

    if (!stopsCache.length) return

    const batch = stopsCache.slice(currentIndex, currentIndex + BATCH_SIZE)

    for (const stop of batch) {
        enqueue(stop.id)
    }

    currentIndex += BATCH_SIZE

    if (currentIndex >= stopsCache.length) {
        currentIndex = 0
    }

    console.log("Batch queued:", currentIndex)
}

// =======================
// WEBSOCKET (GPS)
// =======================
function connectWS() {
    if (isWSConnected) return

    ws = new WebSocket(WS_URL)

    ws.on("open", () => {
        isWSConnected = true
        console.log("WS connected")
    })

    ws.on("message", (msg) => {
        try {
            vehiclesCache = JSON.parse(msg)
        } catch {}
    })

    ws.on("close", () => {
        isWSConnected = false
        console.log("WS reconnect...")
        setTimeout(connectWS, 3000)
    })

    ws.on("error", () => {
        isWSConnected = false
        console.log("WS error")
        ws.close()
    })
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

    // 🔥 ако няма кеш → вкарваме в queue
    if (!arrivalsCache[stopId]) {
        enqueue(stopId)
    }

    res.json(arrivalsCache[stopId] || [])
})

app.get("/vehicles", (req, res) => {
    res.json(vehiclesCache)
})

// =======================
// START
// =======================
app.listen(PORT, () => {
    console.log("Server running on port " + PORT)
})

// =======================
// MAIN
// =======================
async function startServer() {

    console.log("Starting server...")

    // 1. Спирки
    await loadStops()

    // 2. Първоначално зареждане (частично)
    for (let i = 0; i < Math.min(stopsCache.length, 50); i++) {
        enqueue(stopsCache[i].id)
    }

    console.log("Initial queue loaded")

    // 3. Стартираме queue worker
    processQueue()

    // 4. WS GPS
    connectWS()

    // 5. Batch loop
    setInterval(loadArrivals, 5000)

    // 6. Refresh stops
    setInterval(loadStops, 5 * 60 * 1000)
}

startServer()