// Real filesystem test — no mocks
import { readFooterConfig, setPinned } from "../src/config/footer-config.js"

setPinned("context", true)
const result = readFooterConfig()
console.log("RESULT:", JSON.stringify(result))
console.log("HAS context?", result.pinned.includes("context"))