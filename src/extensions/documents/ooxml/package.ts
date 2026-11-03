/**
 * OOXML/ODS package layer over yauzl (read) and jszip (write).
 *
 * All zip parsing is delegated to the libraries — no byte-level zip code
 * here. yauzl reads metadata strictly from the central directory (the only
 * spec-reliable source), validates entry sizes while streaming, and rejects
 * absolute/`..`/backslash names before emitting entries. On top of that
 * metadata this module enforces the hostile-input POLICY:
 *
 *   - entry-count and total-uncompressed caps (POI analogy)
 *   - per-entry 100:1 inflate-ratio rejection over the 100 KB grace size
 *   - symlink entries (Unix mode in `externalFileAttributes`) and
 *     prototype-shadowing names (`__proto__` etc.) rejected up front
 *
 * Parts are inflated only after the census passes; untouched parts are
 * carried through save() unchanged. Inflation is bounded: bytes are counted
 * while streaming (yauzl aborts a stream whose actual size contradicts the
 * central directory — defense against a lying directory), plus a global
 * cumulative cap, plus a per-entry grace abort.
 */

import type { Document as XmlDocument } from "@xmldom/xmldom"
import JSZip from "jszip"
import { type Entry, fromBufferPromise, type ZipFile } from "yauzl"
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

// --- census (library-parsed) --------------------------------------------------

export interface ZipRecord {
	name: string
	compressedSize: number
	uncompressedSize: number
	symlink: boolean
	dir: boolean
}

/**
 * Map a yauzl error to our typed codes: unsafe filenames and declared-vs-
 * actual size violations are hostile-input rejections (safety-limit);
 * everything else is structural breakage (corrupt).
 */
function classifyZipError(err: Error, entry?: string): DocumentError {
	const msg = err.message
	if (
		/absolute path|invalid relative path|invalid characters in fileName/.test(msg) ||
		/too many bytes|too few bytes/.test(msg)
	) {
		return new DocumentError(
			"safety-limit",
			entry ? `Zip entry ${entry} rejected: ${msg}` : `Zip archive rejected: ${msg}`,
		)
	}
	return new DocumentError(
		"corrupt",
		entry ? `Zip entry ${entry} failed to inflate: ${msg}` : `Not a readable zip package: ${msg}`,
	)
}

/**
 * Central-directory census via yauzl: names, sizes, and mode bits for every
 * entry, paired with the live Entry objects (needed to open read streams).
 * Any yauzl parse/structure error maps to DocumentError("corrupt").
 */
export async function censusZip(data: Uint8Array): Promise<{
	records: ZipRecord[]
	zipfile: ZipFile
	entriesByName: Map<string, Entry>
}> {
	let zipfile: ZipFile
	try {
		zipfile = await fromBufferPromise(Buffer.from(data))
	} catch (err) {
		throw classifyZipError(err as Error)
	}
	const records: ZipRecord[] = []
	const entriesByName = new Map<string, Entry>()
	try {
		for await (const entry of zipfile.eachEntry()) {
			const name = entry.fileName
			// Unix mode lives in the high 16 bits when present; on DOS hosts
			// those bits are 0, so testing them unconditionally is safe.
			const mode = entry.externalFileAttributes >>> 16
			records.push({
				name,
				compressedSize: entry.compressedSize,
				uncompressedSize: entry.uncompressedSize,
				symlink: (mode & 0o170000) === 0o120000,
				dir: name.endsWith("/"),
			})
			entriesByName.set(name, entry)
		}
	} catch (err) {
		throw classifyZipError(err as Error)
	}
	return { records, zipfile, entriesByName }
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
	const { records, zipfile } = await censusZip(data)
	zipfile.close()
	return enforceCaps(records).map((r) => r.name)
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
 * Inflate one verified entry through yauzl's read stream. yauzl (with
 * validateEntrySizes, the default) errors mid-stream when actual output
 * contradicts the declared uncompressed size; we additionally abort once
 * output exceeds declared + a small grace window, so a hostile entry can
 * never buffer more than a handful of KB past its declared size. Size
 * mismatches map to safety-limit; structural failures to corrupt.
 */
async function inflateBounded(zipfile: ZipFile, entry: Entry): Promise<Uint8Array> {
	const perEntryCap = entry.uncompressedSize + 4096
	let stream: NodeJS.ReadableStream
	try {
		stream = await zipfile.openReadStreamPromise(entry)
	} catch (err) {
		throw new DocumentError("corrupt", `Cannot open zip entry ${entry.fileName}: ${(err as Error).message}`)
	}
	return new Promise<Uint8Array>((resolve, reject) => {
		const chunks: Uint8Array[] = []
		let actual = 0
		let settled = false
		stream.on("data", (chunk: Uint8Array) => {
			if (settled) return
			const buf = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayLike<number>)
			actual += buf.length
			if (actual > perEntryCap) {
				settled = true
				;(stream as { destroy?: () => void }).destroy?.()
				reject(
					new DocumentError(
						"safety-limit",
						`Zip entry ${entry.fileName} inflates past its declared size (${entry.uncompressedSize} bytes declared, aborted at ${actual})`,
					),
				)
				return
			}
			chunks.push(buf)
		})
		stream.on("end", () => {
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
		stream.on("error", (err: Error) => {
			if (settled) return
			settled = true
			// yauzl's validateEntrySizes fires when actual != declared bytes.
			reject(classifyZipError(err, entry.fileName))
		})
	})
}

export async function openOoxml(data: Uint8Array): Promise<OoxmlPackage> {
	if (!(data[0] === 0x50 && data[1] === 0x4b)) {
		throw new DocumentError("corrupt", "Not a zip package")
	}
	const { records, zipfile, entriesByName } = await censusZip(data)
	const entries = enforceCaps(records)

	const cache = new Map<string, { data: Uint8Array; dirty: boolean }>()
	const removed = new Set<string>()
	// Prime every (capped) part so getBytes/getXml stay synchronous for
	// readers. Streams are counted live; any entry whose real output runs
	// past its declared size + grace is rejected by yauzl or the cap.
	let totalActual = 0
	for (const record of entries) {
		const entry = entriesByName.get(record.name)
		if (!entry) throw new DocumentError("corrupt", `Central directory lists missing entry: ${record.name}`)
		const data = await inflateBounded(zipfile, entry)
		totalActual += data.length
		if (totalActual > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
			throw new DocumentError(
				"safety-limit",
				`Zip total inflated size exceeds cap (${ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`,
			)
		}
		cache.set(record.name, { data, dirty: false })
	}
	zipfile.close()

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
			// Fresh archive from the (capped, verified) cache — jszip is used
			// for writing only, never for parsing untrusted input.
			const zip = new JSZip()
			for (const [name, state] of cache) {
				if (!removed.has(name)) zip.file(name, state.data)
			}
			return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
		},
	}
	return pkg
}
