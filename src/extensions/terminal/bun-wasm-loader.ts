import { file } from "bun"
import wasmPath from "../../../node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm" with { type: "file" }

export async function getWasmDataUrl(): Promise<string> {
  const wasmFile = file(wasmPath)
  const wasmBytes = await wasmFile.arrayBuffer()
  return `data:application/wasm;base64,${Buffer.from(wasmBytes).toString("base64")}`
}
