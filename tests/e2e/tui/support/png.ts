import { crc32, deflateSync } from "node:zlib"

/** Minimal deterministic PNG encoder: solid-color RGB, no filters. */
export function makeSolidPng(width: number, height: number): Buffer {
	const stride = width * 3 + 1
	const raw = Buffer.alloc(stride * height)
	for (let y = 0; y < height; y++) {
		const row = y * stride
		raw[row] = 0 // filter: none
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x * 3] = 0x7a
			raw[row + 2 + x * 3] = 0x3f
			raw[row + 3 + x * 3] = 0x21
		}
	}

	const chunk = (type: string, data: Buffer): Buffer => {
		const len = Buffer.alloc(4)
		len.writeUInt32BE(data.length)
		const body = Buffer.concat([Buffer.from(type, "ascii"), data])
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE(crc32(body) >>> 0)
		return Buffer.concat([len, body, crc])
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // color type: truecolor RGB

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	])
}
