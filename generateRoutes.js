const fs = require("fs")

const API = "https://api.livetransport.eu/stara-zagora"

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

function delay(ms) {
    return new Promise(res => setTimeout(res, ms))
}

const routes = {}

async function main() {

    console.log("📡 Зареждам спирки...")

    const stopsRes = await fetch(`${API}/data`)
    const stopsData = await stopsRes.json()

    const stops = stopsData.stops || []

    console.log("🚏 Общо спирки:", stops.length)

    const foundTrips = new Set()

    // =======================
    // 1. ВЗИМАМЕ ARRIVALS
    // =======================
    for (const stop of stops.slice(0, 80)) { // лимит за безопасност

        try {
            const res = await fetch(`${API}/virtual-board/${stop.id}?limit=10`)
            const data = await res.json()

            const deps = data.departures || []

            for (const a of deps) {
                if (a.tripId && a.vehicleId) {
                    foundTrips.add(JSON.stringify({
                        tripId: a.tripId,
                        vehicleId: a.vehicleId,
                        lineId: a.lineId
                    }))
                }
            }

        } catch {}

        await delay(300) // пазим лимита
    }

    console.log("🧠 Намерени курсове:", foundTrips.size)

    // =======================
    // 2. ВЗИМАМЕ SHAPE
    // =======================
    for (const item of foundTrips) {

        const { vehicleId, lineId } = JSON.parse(item)

        if (routes[lineId]) continue // вече имаме

        try {
            const res = await fetch(`${API}/vehicle/${encodeURIComponent(vehicleId)}`)

            if (!res.ok) continue

            const data = await res.json()

            const shape = data?.trip?.shape

            if (shape && shape.length > 50) {

                routes[lineId] = shape

                console.log(`✅ Линия ${lineId} добавена`)
            }

        } catch {}

        await delay(500)
    }

    // =======================
    // SAVE
    // =======================
    fs.writeFileSync(
        "routes.json",
        JSON.stringify(routes, null, 2)
    )

    console.log("💾 routes.json готов!")
}

main()