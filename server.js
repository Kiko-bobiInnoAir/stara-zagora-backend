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

async function loadArrivals() {

    if (!stopsCache.length) return

    for (const stop of stopsCache) {
        try {

            const res = await fetch(`${API}/virtual-board/${stop.id}?limit=20`)
            const data = await res.json()

            arrivalsCache[stop.id] = data.departures || []

            await new Promise(r => setTimeout(r, 300)) // 🔥 лимит

        } catch (e) {
            console.log("Arrivals error:", stop.id)
        }
    }

    console.log("Arrivals обновени")
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

    console.log("Starting server...")

    // 1. Зареждаме спирките
    await loadStops()

    // 2. Първоначално пълнене (много важно)
   for (let i = 0; i < Math.min(stopsCache.length, 80); i++) {
        try {
            const res = await fetch(`${API}/virtual-board/${stopsCache[i].id}?limit=20`)
            const data = await res.json()
            arrivalsCache[stopsCache[i].id] = data.departures || []

            await new Promise(r => setTimeout(r, 300)) // 🔥 лимит контрол

        } catch (e) {
            console.log("Init error:", stopsCache[i].id)
        }
    }

    console.log("Initial load DONE")

    // 3. LIVE GPS
    connectWS()

    // 4. Обновяване на пристигания (НА ВСЯКА 1 МИНУТА)
    setInterval(loadArrivals, 60000)

    // 5. Обновяване на спирки (на 5 мин)
    setInterval(loadStops, 5 * 60 * 1000)
}

startServer()