import { inflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { encodePngFromBgra } from "./png-encode.js"

/** Parse the single IDAT and inflate it — lets us assert pixel layout
 *  independently of browsers/doctor checks. */
function decode(png: Uint8Array): { ihdr: { width: number; height: number }; raw: Uint8Array } {
	expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const dv = new DataView(png.buffer, png.byteOffset)
	expect(dv.getUint32(8)).toBe(13)
	expect(String.fromCharCode(...png.slice(12, 16))).toBe("IHDR")
	const width = dv.getUint32(16)
	const height = dv.getUint32(20)
	// first chunk is 8 (len+type) +13 +4 (crc) = 25 bytes → IDAT starts at 33
	const idatLen = dv.getUint32(33)
	expect(String.fromCharCode(...png.slice(37, 41))).toBe("IDAT")
	const idat = png.slice(41, 41 + idatLen)
	return { ihdr: { width, height }, raw: inflateSync(idat) }
}

describe("encodePngFromBgra", () => {
	it("round-trips a 1×1 pixel: BGRA → opaque RGBA", () => {
		const png = encodePngFromBgra(1, 1, Uint8Array.from([30, 60, 200, 0]))
		const { ihdr, raw } = decode(png)
		expect(ihdr).toEqual({ width: 1, height: 1 })
		expect(raw).toHaveLength(1 + 4) // filter byte + RGBA
		expect([...raw]).toEqual([0, 200, 60, 30, 255])
	})

	it("emits one filter-0 scanline per row and keeps row stride", () => {
		const w = 3
		const h = 2
		const bgra = new Uint8Array(w * h * 4)
		bgra.fill(0x11)
		const { raw } = decode(encodePngFromBgra(w, h, bgra))
		expect(raw).toHaveLength(h * (1 + w * 4))
		for (let y = 0; y < h; y++) expect(raw[y * (1 + w * 4)]).toBe(0)
	})

	it("rejects invalid dimensions and mismatched buffers", () => {
		expect(() => encodePngFromBgra(0, 1, new Uint8Array(4))).toThrow()
		expect(() => encodePngFromBgra(2, 2, new Uint8Array(4))).toThrow(/expected/)
	})
})
