/**
 * OOXML/ODS package layer over jszip.
 *
 * Hostile-input caps are enforced from the zip CENTRAL DIRECTORY (parsed
 * here, not via jszip internals): jszip collapses `__proto__` entry names
 * into the plain-object prototype and exposes sizes only on an internal
 * field, so the census of "what is in this archive and how big will it
 * inflate" must come from the raw bytes.
 *
 *   - entry-count and total-uncompressed caps (POI analogy)
 *   - per-entry 100:1 inflate-ratio rejection over the 100 KB grace size
 *   - symlink entries (Unix mode in external attributes) and absolute/../
 *     names rejected up front
 *   - ZIP64 size fields honored via the 0x0001 extra record
 *
 * Parts are inflated with jszip only after the census passes; untouched
 * parts are carried through save() unchanged. Inflation itself is bounded:
 * entries are streamed with a running byte counter and aborted when actual
 * output exceeds the declared uncompressed size (LIES-in-the-central-
 * directory defense), plus a global cumulative cap.
 */

import type { Document as XmlDocument } from "@xmldom/xmldom"
import JSZip from "jszip"
import {
	ZIP_GRACE_ENTRY_BYTES,
	ZIP_MAX_ENTRIES,
	ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES,
	ZIP_MIN_INFLATE_RATIO,
} from "../limits.js"
import { DocumentError } from "../model.js"
import { parseXml, serializeXml } from "./xml.js"

const UTF8_DECODER = new TextDecoder("utf-8")
const UTF8_ENCODER = new TextEncoder()

// --- central-directory census ------------------------------------------------

export interface ZipRecord {
	name: string
	compressedSize: number
	uncompressedSize: number
	symlink: boolean
	dir: boolean
}

const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50

function u32(view: DataView, off: number): number {
	return view.getUint32(off, true)
}

function u16(view: DataView, off: number): number {
	return view.getUint16(off, true)
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
	if (utf8) return UTF8_DECODER.decode(bytes)
	// CP437 ~ high-half mapping; exact for ASCII (the common case), lossy for
	// exotic archives — entry names here only feed discrimination, not writes.
	let out = ""
	for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : String.fromCodePoint(0x2500 + b - 0x80)
	return out
}

/**
 * Parse the central directory: names, sizes, and mode bits for every entry.
 * Throws DocumentError("corrupt") when the structure does not parse.
 */
export function scanZip(data: Uint8Array): ZipRecord[] {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
	// EOCD: scan backwards from the end (comment may be up to 64 KB).
	const scanStart = Math.max(0, data.length - (22 + 0xffff + 1))
	let eocd = -1
	for (let i = data.length - 22; i >= scanStart; i--) {
		if (u32(view, i) === EOCD_SIG) {
			eocd = i
			break
		}
	}
	if (eocd < 0) throw new DocumentError("corrupt", "Not a readable zip package (no end-of-central-directory)")
	const entryCount = u16(view, eocd + 10)
	let offset = u32(view, eocd + 16)

	const records: ZipRecord[] = []
	for (let i = 0; i < entryCount; i++) {
		if (offset + 46 > data.length || u32(view, offset) !== CDIR_SIG) {
			throw new DocumentError("corrupt", "Bad central directory record")
		}
		const versionMadeBy = u16(view, offset + 4)
		const flags = u16(view, offset + 8)
		let compressedSize = u32(view, offset + 20)
		let uncompressedSize = u32(view, offset + 24)
		const nameLen = u16(view, offset + 28)
		const extraLen = u16(view, offset + 30)
		const commentLen = u16(view, offset + 32)
		const externalAttrs = u32(view, offset + 38)

		const extraStart = offset + 46 + nameLen
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
			// ZIP64 extra record 0x0001: uncompressed then compressed, 8 bytes each.
			let p = extraStart
			while (p + 4 <= extraStart + extraLen) {
				const id = u16(view, p)
				const size = u16(view, p + 2)
				if (id === 0x0001) {
					let q = p + 4
					if (uncompressedSize === 0xffffffff) {
						uncompressedSize = Number(view.getBigUint64(q, true))
						q += 8
					}
					if (compressedSize === 0xffffffff && q + 8 <= p + 4 + size) {
						compressedSize = Number(view.getBigUint64(q, true))
					}
					break
				}
				p += 4 + size
			}
		}

		const nameBytes = data.subarray(offset + 46, offset + 46 + nameLen)
		const name = decodeName(nameBytes, (flags & 0x800) !== 0)
		// Unix mode lives in the high 16 bits when present; on DOS hosts those
		// bits are 0, so testing them unconditionally is safe (Archivers that
		// only write DOS attrs never set S_IFLNK there).
		void versionMadeBy
		const mode = externalAttrs >>> 16
		const symlink = (mode & 0o170000) === 0o120000
		const dir = name.endsWith("/")
		records.push({ name, compressedSize, uncompressedSize, symlink, dir })
		offset += 46 + nameLen + extraLen + commentLen
	}
	return records
}

function validateEntryName(name: string): void {
	if (name.startsWith("/") || /^[A-Za-z]:[/\\]/.test(name)) {
		throw new DocumentError("safety-limit", `Zip entry uses an absolute path: ${name}`)
	}
	if (name.split(/[/\\]/).includes("..")) {
		throw new DocumentError("safety-limit", `Zip entry escapes the archive root: ${name}`)
	}
}

function enforceCaps(records: ZipRecord[]): ZipRecord[] {
	if (records.length > ZIP_MAX_ENTRIES) {
		throw new DocumentError("safety-limit", `Zip entry count ${records.length} exceeds cap ${ZIP_MAX_ENTRIES}`)
	}
	let totalUncompressed = 0
	for (const record of records) {
		if (record.name === "__proto__" || record.name === "constructor" || record.name === "prototype") {
			throw new DocumentError("safety-limit", `Zip entry name shadows an Object prototype key: ${record.name}`)
		}
		validateEntryName(record.name)
		if (record.symlink) {
			throw new DocumentError("safety-limit", `Zip entry is a symlink: ${record.name}`)
		}
		if (record.uncompressedSize > ZIP_GRACE_ENTRY_BYTES && record.compressedSize > 0) {
			const ratio = record.compressedSize / record.uncompressedSize
			if (ratio < ZIP_MIN_INFLATE_RATIO) {
				throw new DocumentError(
					"safety-limit",
					`Zip entry ${record.name} inflates ${Math.round(record.uncompressedSize / record.compressedSize)}:1 (cap 100:1)`,
				)
			}
		}
		totalUncompressed += record.uncompressedSize
	}
	if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
		throw new DocumentError(
			"safety-limit",
			`Zip total uncompressed size ${totalUncompressed} exceeds cap ${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES}`,
		)
	}
	return records.filter((r) => !r.dir)
}

// --- public API ---------------------------------------------------------------

/** Entry names (files only) with all caps enforced — detect.ts uses this
 *  before any inflation happens. */
export async function listZipEntries(data: Uint8Array): Promise<string[]> {
	return enforceCaps(scanZip(data)).map((r) => r.name)
}

export interface OoxmlPackage {
	names(): string[]
	getBytes(name: string): Uint8Array | undefined
	putBytes(name: string, data: Uint8Array): void
	getXml(name: string): XmlDocument
	hasXml(name: string): boolean
	putXml(name: string, doc: XmlDocument): void
	/** Drop a part and any parts under it when recursive (delete_slide uses it). */
	remove(name: string, opts?: { recursive?: boolean }): void
	/** Saves with untouched entries carried byte-for-byte from the original. */
	save(): Promise<Uint8Array>
}

/**
 * Inflate one verified entry, aborting once actual output exceeds the
 * declared uncompressed size past a small grace window (declared sizes are
 * attacker-controlled); also enforces the per-entry inflated cap.
 */
interface InflateWorker {
	on(event: "data", cb: (chunk: unknown) => void): this
	on(event: "end", cb: () => void): this
	on(event: "error", cb: (err: Error) => void): this
	pause?(): void
	resume?(): void
}

/** jszip's .d.ts doesn't declare internalStream on JSZipObject; runtime has it. */
function internalStream(file: JSZip.JSZipObject): InflateWorker {
	return (file as unknown as { internalStream(type: "uint8array"): InflateWorker }).internalStream("uint8array")
}

async function inflateBounded(file: JSZip.JSZipObject, entry: zipEntryName): Promise<Uint8Array> {
	// Declared sizes are attacker-controlled; honest entries never grow past
	// what the central directory says. Grace covers deflator rounding quirks.
	const perEntryCap = entry.uncompressedSize + 4096
	return new Promise<Uint8Array>((resolve, reject) => {
		const chunks: Uint8Array[] = []
		let actual = 0
		let settled = false
		const worker = internalStream(file)
		worker
			.on("data", (chunk) => {
				if (settled) return
				const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayLike<number>)
				actual += buf.length
				if (actual > perEntryCap) {
					settled = true
					worker.pause?.()
					reject(
						new DocumentError(
							"safety-limit",
							`Zip entry ${entry.name} inflates past its declared size (${entry.uncompressedSize} bytes declared, aborted at ${actual})`,
						),
					)
					return
				}
				chunks.push(buf)
			})
			.on("end", () => {
				if (settled) return
				settled = true
				const out = new Uint8Array(actual)
				let off = 0
				for (const c of chunks) {
					out.set(c, off)
					off += c.length
				}
				resolve(out)
			})
			.on("error", (err) => {
				if (settled) return
				settled = true
				reject(err)
			})
		// jszip workers start paused; events only flow after resume().
		worker.resume?.()
	})
}

interface zipEntryName {
	name: string
	uncompressedSize: number
}

export async function openOoxml(data: Uint8Array): Promise<OoxmlPackage> {
	if (!(data[0] === 0x50 && data[1] === 0x4b)) {
		throw new DocumentError("corrupt", "Not a zip package")
	}
	const entries = enforceCaps(scanZip(data))

	let zip: JSZip
	try {
		zip = await JSZip.loadAsync(data)
	} catch (err) {
		throw new DocumentError("corrupt", `Not a readable zip package: ${(err as Error).message}`)
	}

	const cache = new Map<string, { data: Uint8Array; dirty: boolean }>()
	const removed = new Set<string>()
	// Prime every (capped) part so getBytes/getXml stay synchronous for
	// readers. STREAM, counting actual inflated bytes: a hostile archive can
	// lie about sizes in the central directory (jszip validates only at end-
	// of-stream, after buffering everything), so any entry whose real output
	// runs past its declared size + grace is rejected mid-stream.
	let totalActual = 0
	for (const entry of entries) {
		const file = zip.file(entry.name)
		if (!file) throw new DocumentError("corrupt", `Central directory lists missing entry: ${entry.name}`)
		const data = await inflateBounded(file, entry)
		totalActual += data.length
		if (totalActual > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
			throw new DocumentError(
				"safety-limit",
				`Zip total inflated size exceeds cap (${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`,
			)
		}
		cache.set(entry.name, { data, dirty: false })
	}

	const pkg: OoxmlPackage = {
		names: () => [...cache.keys()],
		getBytes: (name) => cache.get(name)?.data,
		putBytes: (name, bytes) => {
			validateEntryName(name)
			cache.set(name, { data: bytes, dirty: true })
		},
		getXml: (name) => {
			const bytes = cache.get(name)?.data
			if (!bytes) throw new DocumentError("corrupt", `Missing XML part: ${name}`)
			return parseXml(UTF8_DECODER.decode(bytes))
		},
		hasXml: (name) => cache.has(name),
		putXml: (name, doc) => {
			validateEntryName(name)
			removed.delete(name)
			cache.set(name, { data: UTF8_ENCODER.encode(serializeXml(doc)), dirty: true })
		},
		remove: (name, opts) => {
			for (const part of [...cache.keys()]) {
				if (part === name || (opts?.recursive && part.startsWith(name))) {
					cache.delete(part)
					removed.add(part)
				}
			}
		},
		save: async () => {
			for (const name of removed) zip.remove(name)
			for (const [name, state] of cache) {
				if (state.dirty) zip.file(name, state.data)
			}
			return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
		},
	}
	return pkg
}
