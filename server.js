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

// =======================
// RATE LIMIT CONTROL
// =======================
const REQUESTS_PER_SECOND = 3
const REQUEST_DELAY = 1000 / REQUESTS_PER_SECOND

function delay(ms) {
    return new Promise(res => setTimeout(res, ms))
}

// =======================
// НОЩЕН РЕЖИМ
// =======================
function isServerActive() {
    const hour = new Date().toLocaleString("en-US", {
        timeZone: "Europe/Sofia",
        hour: "numeric",
        hour12: false
    })

    const h = parseInt(hour)
    return !(h >= 0 && h < 5)
}

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
        console.log("Stops error:", e.message)
    }
}

// =======================
// ARRIVALS (SMART LOOP)
// =======================
let currentIndex = 0

async function arrivalsLoop() {
    while (true) {

        if (!isServerActive()) {
            console.log("🌙 Night mode - arrivals paused")
            await delay(5000)
            continue
        }

        if (!stopsCache.length) {
            await delay(2000)
            continue
        }

        const stop = stopsCache[currentIndex]

        try {
            const res = await fetch(`${API}/virtual-board/${stop.id}?limit=20`)
            const data = await res.json()

            arrivalsCache[stop.id] = data.departures || []

        } catch (e) {
            console.log("Arrival error:", stop.id)
        }

        currentIndex++
        if (currentIndex >= stopsCache.length) {
            currentIndex = 0
        }

        await delay(REQUEST_DELAY)
    }
}

// =======================
// WEBSOCKET
// =======================
function connectWS() {
    if (!isServerActive()) return
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
}

function stopWS() {
    if (ws && isWSConnected) {
        ws.close()
        ws = null
        isWSConnected = false
        console.log("WS stopped")
    }
}

// =======================
// CACHE CLEAN
// =======================
function clearCache() {
    arrivalsCache = {}
    vehiclesCache = []
    console.log("Cache cleared")
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
    await loadStops()

    connectWS()

    arrivalsLoop() // 🔥 continuous controlled loop

    setInterval(() => {
        if (!isServerActive()) {
            stopWS()
            clearCache()
        } else {
            connectWS()
        }
    }, 60000)
}

startServer()