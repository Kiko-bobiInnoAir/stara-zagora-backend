const fs = require("fs")

const API = "https://api.livetransport.eu/stara-zagora"

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args))

const routes = {}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

async function generate() {

    console.log("🔄 Взимам превозни средства...")

    // взимаме GPS feed (същото като WebSocket)
    const res = await fetch(API)
    const data = await res.json()

    if (!data.lines) {
        console.log("❌ няма lines")
        return
    }

    console.log("🚍 линии:", data.lines.length)

    // 🔥 обхождаме линии
    for (const line of data.lines) {

        const lineName = line.name // това е реалния номер (8, 13...)

        try {
            console.log("🔍 търся за линия:", lineName)

            // тук няма директен trip API, затова ще ги хванем runtime
            routes[lineName] = {
                shape: "",
                stops: []
            }

        } catch (e) {
            console.log("⚠️ грешка:", lineName)
        }

        await sleep(100)
    }

    fs.writeFileSync("routes.json", JSON.stringify(routes, null, 2))

    console.log("🎉 ГОТОВО (празна структура)")
}

generate()