/**
 * Minimal PNG encoder — takes raw BGRA/RGBA pixels, emits a valid PNG.
 * No dependencies beyond node:zlib: this is what lets us render PDF pages
 * through the PDFium WASM build (which hands out raw bitmaps) without
 * pulling in a native image library.
 */

import { deflateSync } from "node:zlib"

const PNG_SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** CRC32 table, computed once. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff
	for (const b of bytes) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff]
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type)
	const out = new Uint8Array(8 + data.length + 4)
	const dv = new DataView(out.buffer)
	dv.setUint32(0, data.length)
	out.set(typeBytes, 4)
	out.set(data, 8)
	dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
	return out
}

function concat(parts: Uint8Array[]): Uint8Array {
	let total = 0
	for (const p of parts) total += p.length
	const out = new Uint8Array(total)
	let off = 0
	for (const p of parts) {
		out.set(p, off)
		off += p.length
	}
	return out
}

/**
 * Encode BGRA pixel data (PDFium's native layout) as RGBA PNG.
 * One IDAT with filter 0 per scanline — simple, valid, deterministic.
 */
export function encodePngFromBgra(width: number, height: number, bgra: Uint8Array): Uint8Array {
	if (width < 1 || height < 1) throw new Error(`png: invalid dims ${width}x${height}`)
	if (bgra.length !== width * height * 4)
		throw new Error(`png: expected ${width * height * 4} px bytes, got ${bgra.length}`)
	// BGRA → RGBA, force alpha to opaque (scan backgrounds should not be
	// transparent; PDFium alpha is unreliable for images on white pages).
	const raw = new Uint8Array(height * (1 + width * 4))
	for (let y = 0; y < height; y++) {
		const srcOff = y * width * 4
		const dstOff = y * (1 + width * 4)
		raw[dstOff] = 0 // filter: none
		for (let x = 0; x < width; x++) {
			const s = srcOff + x * 4
			const d = dstOff + 1 + x * 4
			raw[d] = bgra[s + 2] // R
			raw[d + 1] = bgra[s + 1] // G
			raw[d + 2] = bgra[s] // B
			raw[d + 3] = 255 // A
		}
	}
	const ihdr = new Uint8Array(13)
	const dv = new DataView(ihdr.buffer)
	dv.setUint32(0, width)
	dv.setUint32(4, height)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type: RGBA
	// compression 0, filter 0, interlace 0 — bytes 10..12 stay 0
	return concat([
		PNG_SIG,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 6 })),
		chunk("IEND", new Uint8Array(0)),
	])
}
