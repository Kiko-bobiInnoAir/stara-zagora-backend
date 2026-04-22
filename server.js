const express = require("express")
const WebSocket = require("ws")

const app = express()
const PORT = process.env.PORT || 3000

const API = "https://api.livetransport.eu/stara-zagora"
const WS = "wss://api.livetransport.eu/stara-zagora"

let stopsCache = []
let arrivalsCache = {}
let vehiclesCache = []

// FETCH
const fetch = (...args) =>
    import('node-fetch').then(({default: fetch}) => fetch(...args))

// =======================
// СПИРКИ
// =======================
async function loadStops() {
    try {
        const res = await fetch(`${API}/data`)
        const data = await res.json()
        stopsCache = data.stops || []
        console.log("Stops:", stopsCache.length)
    } catch (e) {
        console.log("Stops error", e.message)
    }
}

// =======================
// ARRIVALS (BATCH)
// =======================
let currentIndex = 0
const BATCH_SIZE = 10

async function loadArrivals() {

    if (!stopsCache.length) return

    const batch = stopsCache.slice(currentIndex, currentIndex + BATCH_SIZE)

    for (const stop of batch) {
        try {
            const res = await fetch(`${API}/virtual-board/${stop.id}?limit=20`)
            const data = await res.json()

            arrivalsCache[stop.id] = data.departures || []

        } catch (e) {
            console.log("Arrivals error:", stop.id)
        }

        await new Promise(r => setTimeout(r, 400))
    }

    currentIndex += BATCH_SIZE

    if (currentIndex >= stopsCache.length) {
        currentIndex = 0
    }

    console.log("Batch:", currentIndex)
}

// =======================
// WEBSOCKET (СТАРИЯТ РАБОТЕЩ)
// =======================
function connectWS() {

    console.log("Connecting WS...")

    const ws = new WebSocket(WS)

    ws.on("open", () => {
        console.log("WS connected")
    })

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg)
            vehiclesCache = data

            console.log("Vehicles:", Array.isArray(data) ? data.length : "?")
        } catch {}
    })

    ws.on("close", () => {
        console.log("WS reconnect...")
        setTimeout(connectWS, 2000)
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
    res.json(arrivalsCache[req.params.stopId] || [])
})

app.get("/vehicles", (req, res) => {
    res.json(vehiclesCache)
})

// =======================
// START
// =======================
app.listen(PORT, async () => {

    console.log("Server started")

    await loadStops()

    // първоначално зареждане (частично)
    for (let i = 0; i < Math.min(stopsCache.length, 50); i++) {
        try {
            const res = await fetch(`${API}/virtual-board/${stopsCache[i].id}?limit=20`)
            const data = await res.json()

            arrivalsCache[stopsCache[i].id] = data.departures || []

            await new Promise(r => setTimeout(r, 300))
        } catch {}
    }

    console.log("Initial load done")

    connectWS()

    // 🔥 ключово
    setInterval(loadArrivals, 5000)

    setInterval(loadStops, 5 * 60 * 1000)
})