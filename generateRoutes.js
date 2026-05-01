const fs = require("fs")

const BASE = "https://api.livetransport.eu/stara-zagora"

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

const routes = {}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function generate() {

    console.log("🔄 Взимам всички линии...")

    const res = await fetch(`${BASE}/data`)
    const data = await res.json()

    const lines = data.lines || []

    console.log("🚌 Линии намерени:", lines.length)

    for (const line of lines) {

        const lineId = line.id

        try {
            const res = await fetch(`${BASE}/line/${lineId}`)
            if (!res.ok) continue

            const data = await res.json()

            const shape = data?.shape
            const stops = data?.stops

            if (!shape || shape.length < 10) continue

            routes[line.name] = {
                shape,
                stops: stops || []
            }

            console.log("✅ линия:", line.name)

            await sleep(200)

        } catch (e) {
            console.log("⚠️ грешка:", lineId)
        }
    }

    fs.writeFileSync("routes.json", JSON.stringify(routes, null, 2))

    console.log("🎉 ВСИЧКИ ЛИНИИ ГОТОВИ!")
}

generate()