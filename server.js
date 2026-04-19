const express = require("express")

const app = express()
const PORT = 3000

const API = "https://api.livetransport.eu/stara-zagora"
const WS = "wss://api.livetransport.eu/stara-zagora"

let stopsCache = []
let arrivalsCache = {}
let vehiclesCache = []

// 🔥 FETCH FIX (Node)
const fetch = (...args) =>
    import('node-fetch').then(({default: fetch}) => fetch(...args))

// =======================
// 📍 СПИРКИ
// =======================
async function loadStops() {
    try {
        const res = await fetch(`${API}/data`)
        const data = await res.json()
        stopsCache = data.stops
        console.log("Stops updated")
    } catch (e) {
        console.log("Stops error", e.message)
    }
}

// =======================
// 🚌 ПРИСТИГАНИЯ
// =======================
async function loadArrivals() {
    if (!stopsCache.length) return

    let currentIndex = 0
const BATCH_SIZE = 20

async function loadArrivalsBatch() {
    if (!stopsCache.length) return
    if (!serverActive) return

    const batch = stopsCache.slice(currentIndex, currentIndex + BATCH_SIZE)

    for (const stop of batch) {
        try {
            const res = await fetch(`${API}/virtual-board/${stop.id}?limit=20`)
            const data = await res.json()

            arrivalsCache[stop.id] = data.departures || []

        } catch (e) {
            console.log("Arrivals error:", stop.id)
        }
    }

    currentIndex += BATCH_SIZE

    if (currentIndex >= stopsCache.length) {
        currentIndex = 0
    }

    console.log("Batch updated:", currentIndex)
}

// =======================
// 📡 LIVE GPS (WebSocket)
// =======================
function connectWS() {
    const WebSocket = require("ws")
    const ws = new WebSocket(WS)

    ws.on("open", () => {
        console.log("WS connected")
    })

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg)
            vehiclesCache = data
        } catch (e) {}
    })

    ws.on("close", () => {
        console.log("WS reconnect...")
        setTimeout(connectWS, 2000)
    })
}

// =======================
// 🌐 API ENDPOINTS
// =======================

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
// ⏱ START
// =======================
app.listen(PORT, async () => {
    console.log("Server running on 3000")

    await loadStops()
    await loadArrivals()

    connectWS()

    setInterval(loadArrivals, 10000) // 10 сек
})