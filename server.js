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

// FETCH
const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

// =======================
// СПИРКИ
// =======================
async function loadStops() {
    try {
        const res = await fetch(`${API}/data`)
        const text = await res.text()

        if (!text.startsWith("{")) {
            console.log("Invalid response:", text)
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
// ARRIVALS (SMART LOOP)
// =======================
let currentIndex = 0
const BATCH_SIZE = 10

async function loadArrivals() {

    if (!stopsCache.length) return

    const batch = stopsCache.slice(currentIndex, currentIndex + BATCH_SIZE)

    for (const stop of batch) {
        try {
            const res = await fetch(`${API}/virtual-board/${stop.id}?limit=20`)

            const text = await res.text()

            if (!text.startsWith("{")) {
                console.log("Rate limited:", stop.id)
                continue
            }

            const data = JSON.parse(text)
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

    console.log("Batch done:", currentIndex)
}

// =======================
// WEBSOCKET (FIXED)
// =======================
function connectWS() {

    console.log("Connecting WS...")

    ws = new WebSocket(WS_URL)

    ws.on("open", () => {
        isWSConnected = true
        console.log("WS connected")

        // 🔥 ЗАДЪЛЖИТЕЛНО
        ws.send(JSON.stringify({
            action: "subscribe",
            channel: "vehicles"
        }))
    })

    ws.on("message", (msg) => {
        try {
            const data = JSON.parse(msg)

            vehiclesCache = data

            console.log("Vehicles:", Array.isArray(data) ? data.length : "?")

        } catch {}
    })

    ws.on("close", () => {
        isWSConnected = false
        console.log("WS reconnect...")
        setTimeout(connectWS, 3000)
    })

    ws.on("error", (err) => {
        console.log("WS error:", err.message)
    })
}

// =======================
// HTTP fallback (много важно)
// =======================
async function loadVehicles() {
    try {
        const res = await fetch(`${API}/vehicles`)
        const data = await res.json()

        vehiclesCache = data

        console.log("Vehicles HTTP:", data.length)
    } catch {
        console.log("Vehicles HTTP error")
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
    res.json(arrivalsCache[req.params.stopId] || [])
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

    await loadStops()

    // 🔥 първоначално (само частично)
    for (let i = 0; i < Math.min(stopsCache.length, 50); i++) {
        try {
            const res = await fetch(`${API}/virtual-board/${stopsCache[i].id}?limit=20`)
            const data = await res.json()

            arrivalsCache[stopsCache[i].id] = data.departures || []

            await new Promise(r => setTimeout(r, 300))
        } catch {}
    }

    console.log("Initial load DONE")

    connectWS()

    // 🔥 ТОВА Е КЛЮЧА
    setInterval(loadArrivals, 5000) // НЕ 60 сек!!!

    setInterval(loadStops, 5 * 60 * 1000)

    setInterval(loadVehicles, 5000) // fallback
}

startServer()