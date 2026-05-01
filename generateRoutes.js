const fs = require("fs")

const BASE = "https://stara-zagora-backend.onrender.com"
const API = "https://api.livetransport.eu/stara-zagora"

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

const routes = {}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function generate() {

    console.log("🔄 Взимам vehicles от твоя backend...")

    const res = await fetch(`${BASE}/vehicles`)

    if (!res.ok) {
        console.log("❌ Backend error")
        return
    }

    const vehicles = await res.json()

    if (!Array.isArray(vehicles)) {
        console.log("❌ НЕ Е МАСИВ:", vehicles)
        return
    }

    console.log("🚍 Намерени:", vehicles.length)

    for (const v of vehicles) {

        const vehicleId = v[0]

        if (!vehicleId) continue

        try {
            const tripRes = await fetch(
                `${API}/vehicle/${encodeURIComponent(vehicleId)}`
            )

            if (!tripRes.ok) continue

            const data = await tripRes.json()
            const trip = data?.trip

            if (!trip || !trip.shape || trip.shape.length < 10) continue

            const lineId = trip?.route?.shortName || ""

            if (!lineId) continue

            if (!routes[lineId]) {
                routes[lineId] = {
                    shape: trip.shape,
                    stops: trip.stops || []
                }

                console.log("✅ Добавена линия:", lineId)
            }

            await sleep(150)

        } catch (e) {
            console.log("⚠️ грешка:", vehicleId)
        }
    }

    fs.writeFileSync("routes.json", JSON.stringify(routes, null, 2))

    console.log("🎉 ГОТОВО! routes.json създаден")
}

generate()