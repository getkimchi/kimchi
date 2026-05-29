import { GhosttyCore } from "@wterm/ghostty"

let dataUrl: string | undefined

async function getWasmDataUrl(): Promise<string> {
  if (dataUrl) return dataUrl

  if (typeof Bun !== "undefined") {
    const { getWasmDataUrl: bunGetWasmDataUrl } = await import("./bun-wasm-loader.js")
    dataUrl = await bunGetWasmDataUrl()
    return dataUrl
  }

  const fs = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const wasmPath = fileURLToPath(
    new URL("../../../node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm", import.meta.url),
  )
  const wasmBytes = fs.readFileSync(wasmPath)
  dataUrl = `data:application/wasm;base64,${wasmBytes.toString("base64")}`
  return dataUrl
}

export async function createGhosttyCore(cols = 80, rows = 24): Promise<GhosttyCore> {
  const core = await GhosttyCore.load({ wasmPath: await getWasmDataUrl() })
  core.init(cols, rows)
  return core
}
