import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { GhosttyCore } from "@wterm/ghostty"

let dataUrl: string | undefined

function getWasmDataUrl(): string {
	if (dataUrl) return dataUrl
	const wasmPath = fileURLToPath(
		new URL("../../../node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm", import.meta.url),
	)
	const wasmBytes = fs.readFileSync(wasmPath)
	dataUrl = `data:application/wasm;base64,${wasmBytes.toString("base64")}`
	return dataUrl
}

export async function createGhosttyCore(cols = 80, rows = 24): Promise<GhosttyCore> {
	const core = await GhosttyCore.load({ wasmPath: getWasmDataUrl() })
	core.init(cols, rows)
	return core
}
