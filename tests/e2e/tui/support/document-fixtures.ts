// Self-contained synthetic document fixtures for TUI e2e tests.
// Kept dependency-local on purpose: the tui-test cache flattens test files,
// so runtime imports into src/… resolve against the wrong base. Unit-level
// extractor coverage lives in src/extensions/documents/** — these fixtures
// only need to survive round-tripping through the extraction pipeline.

import { deflateSync } from "node:zlib"
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib"

/** Tiny two-page PDF with extractable text (no pdfjs needed to build). */
export async function makeSimplePdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	for (const text of ["Hello from page one", "and a second page."]) {
		const page = doc.addPage([200, 200])
		page.drawText(text, { x: 20, y: 160, size: 12, font })
	}
	return doc.save()
}

/** Scanned-receipt class PDF: full-page raster image, no text layer (Phase 1.6). */
export async function makeScannedPdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const png = await doc.embedPng(encodeSolidPng(8, 8, 200, 30, 30))
	for (let i = 0; i < 2; i++) {
		const page = doc.addPage([255, 340])
		page.drawImage(png, { x: 0, y: 0, width: 255, height: 340 })
	}
	return doc.save()
}

/** Minimal RGB PNG encoder (mirror of the one in src fixtures — see header note). */
function encodeSolidPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
	const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const ihdr = new Uint8Array(13)
	const view = new DataView(ihdr.buffer)
	view.setUint32(0, width)
	view.setUint32(4, height)
	ihdr[8] = 8
	ihdr[9] = 2
	const pixelRow = new Uint8Array(width * 3 + 1)
	for (let x = 0; x < width; x++) {
		pixelRow[1 + x * 3] = r
		pixelRow[2 + x * 3] = g
		pixelRow[3 + x * 3] = b
	}
	const pixels = new Uint8Array(pixelRow.length * height)
	for (let y = 0; y < height; y++) pixels.set(pixelRow, y * pixelRow.length)
	const idat = new Uint8Array(deflateSync(pixels))
	const chunk = (type: string, body: Uint8Array): Uint8Array => {
		const out = new Uint8Array(12 + body.length)
		const v = new DataView(out.buffer)
		v.setUint32(0, body.length)
		out.set([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)], 4)
		out.set(body, 8)
		v.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)) >>> 0)
		return out
	}
	const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]
	const combined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) {
		combined.set(p, at)
		at += p.length
	}
	return combined
}

// CRC-32 (zlib, poly 0xedb88320) — portable across runtimes
function crc32(buf: Uint8Array): number {
	let crc = 0xffffffff
	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i]
		for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
	}
	return ~crc
}
