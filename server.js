const express = require("express")
const WebSocket = require("ws")

const app = express()

const API = "https://api.livetransport.eu/stara-zagora"
const WS = "wss://api.livetransport.eu/stara-zagora"

let stopsCache = []
let arrivalsCache = {}
let vehiclesCache = []

// 🔥 FETCH FIX
const fetch = (...args) =>
    import('node-fetch').then(({default: fetch}) => fetch(...args))

// =======================
// 📍 СПИРКИ
// =======================
async function loadStops() {
    try {
        const res = await fetch(`${API}/data`)
        const data = await res.json()
        stopsCache = data.stops || []
        console.log("Stops updated:", stopsCache.length)
    } catch (e) {
        console.log("Stops error", e.message)
    }
}

// =======================
// 🚌 ПРИСТИГАНИЯ (BATCH)
// =======================
let currentIndex = 0
const BATCH_SIZE = 20

async function loadArrivalsBatch() {
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
    }

    currentIndex += BATCH_SIZE
    if (currentIndex >= stopsCache.length) currentIndex = 0

    console.log("Batch updated:", currentIndex)
}

// =======================
// 📡 LIVE GPS
// =======================
function connectWS() {
    const ws = new WebSocket(WS)

    ws.on("open", () => {
        console.log("WS connected")
    })

    ws.on("message", (msg) => {
        try {
            vehiclesCache = JSON.parse(msg)
        } catch (e) {}
    })

    ws.on("close", () => {
        console.log("WS reconnect...")
        setTimeout(connectWS, 2000)
    })
}

// =======================
// 🌐 API
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
// 🚀 START
// =======================
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
    console.log("Server running on port " + PORT)
})

// стартиране
async function startServer() {
    await loadStops()
    connectWS()

    // 🔥 въртим batch на всеки 3 сек (няма да надвишиш лимита)
    setInterval(loadArrivalsBatch, 3000)

    // обновяване на спирките на 5 мин
    setInterval(loadStops, 300000)
}

startServer()