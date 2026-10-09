/**
 * Fixture-driven self-check behind `kimchi documents doctor` — the
 * per-target proof of the "same results on every release target" constraint.
 * It runs the synthetic corpus through every shipped capability and compares
 * against goldens embedded at build time; CI runs it on each of the 5 build
 * targets (canary/release) and the check is deliberately corruptible so its
 * failure path is tested too.
 */

import { existsSync } from "node:fs"
import JSZip from "jszip"
import * as XLSX from "xlsx"
import { extractDocument } from "./extract.js"
import { makeScannedPdf, makeSimpleDocx, makeSimplePdf, makeSimplePptx } from "./fixtures/builders.js"
import { isDocumentError } from "./model.js"
import { listZipEntries } from "./ooxml/package.js"
import { resolvePdfjsAssets } from "./pdfjs-assets.js"
import { loadCanvas, maybeRenderScannedPages } from "./render-pages.js"

export interface DoctorCheck {
	name: string
	ok: boolean
	detail?: string
}

export interface DoctorReport {
	ok: boolean
	platform: string
	arch: string
	/** Where PDF.js data assets came from ("share/kimchi/pdfjs" or "node_modules/pdfjs-dist"). */
	assetSource?: string
	checks: DoctorCheck[]
}

/** Expected extraction text per fixture — embedded at build time. */
export interface DoctorGoldens {
	pdfPage1: string
	pdfPage2: string
	docxContains: string[]
	pptxContains: string[]
	xlsxContains: string[]
}

export const DEFAULT_GOLDENS: DoctorGoldens = {
	pdfPage1: "Hello from page one",
	pdfPage2: "Second page content",
	docxContains: ["# Quarterly Report", "Revenue grew in Q3 across all regions.", "[table 1]", "| North | 42 |"],
	pptxContains: ['[shape "Title 1"]', "Kickoff", "*hidden slide*", "Notes:", "Remember to thank sponsors"],
	xlsxContains: ["|  | A | B |", "| 2 | North | 42 |"],
}

export async function runDoctor(deps: { goldens?: Partial<DoctorGoldens> } = {}): Promise<DoctorReport> {
	const goldens: DoctorGoldens = { ...DEFAULT_GOLDENS, ...deps.goldens }
	const checks: DoctorCheck[] = []
	const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail })

	// 1. PDF.js assets resolvable (CMaps + standard fonts shipped with the build).
	let assetSource: string | undefined
	try {
		const assets = resolvePdfjsAssets()
		assetSource = assets.source
		const cMaps = existsSync(assets.cMapUrl) ? assets.cMapUrl : undefined
		const fonts = existsSync(assets.standardFontDataUrl) ? assets.standardFontDataUrl : undefined
		push("pdfjs-assets", cMaps !== undefined && fonts !== undefined, assets.source)
	} catch (err) {
		push("pdfjs-assets", false, (err as Error).message)
	}

	// 2. Read extraction per format against goldens.
	try {
		const doc = await extractDocument("doctor.pdf", await makeSimplePdf(), { tool: "doctor" })
		push(
			"read-pdf",
			doc.units.length === 2 &&
				doc.units[0].markdown.includes(goldens.pdfPage1) &&
				doc.units[1].markdown.includes(goldens.pdfPage2),
		)
	} catch (err) {
		push("read-pdf", false, (err as Error).message)
	}
	try {
		const doc = await extractDocument("doctor.docx", await makeSimpleDocx(), { tool: "doctor" })
		const md = doc.units[0].markdown
		push(
			"read-docx",
			goldens.docxContains.every((needle) => md.includes(needle)),
		)
	} catch (err) {
		push("read-docx", false, (err as Error).message)
	}
	try {
		const doc = await extractDocument("doctor.pptx", await makeSimplePptx(), { tool: "doctor" })
		const text = doc.units.map((u) => u.markdown).join("\n")
		push("read-pptx", doc.units.length === 3 && goldens.pptxContains.every((needle) => text.includes(needle)))
	} catch (err) {
		push("read-pptx", false, (err as Error).message)
	}
	try {
		const wb = XLSX.utils.book_new()
		const ws = XLSX.utils.aoa_to_sheet([
			["Name", "Amount"],
			["North", 42],
		])
		XLSX.utils.book_append_sheet(wb, ws, "Totals")
		const data = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
		const doc = await extractDocument("doctor.xlsx", data, { tool: "doctor" })
		push(
			"read-xlsx",
			goldens.xlsxContains.every((needle) => doc.units[0].markdown.includes(needle)),
		)
	} catch (err) {
		push("read-xlsx", false, (err as Error).message)
	}

	// 3. Page images (Phase 1.6): canvas availability is REPORTED, and when
	// canvas loads, a scanned page is rendered through the full pipeline.
	// Non-fatal by design — doctor must stay green on targets or environments
	// where the native addon fails (scanned pages degrade to warnings there).
	{
		const { canvas, error } = await loadCanvas()
		push("canvas", true, canvas ? "available" : `unavailable: ${error ?? "load failed"}`)
		if (canvas) {
			try {
				const data = await makeScannedPdf()
				const doc = await extractDocument("scan.pdf", data, { tool: "doctor" })
				const outcome = await maybeRenderScannedPages({ data, doc, supportsImages: true })
				const pngMagicOk = outcome.images.every((img) => {
					const bytes = Buffer.from(img.data, "base64")
					return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
				})
				push("page-images", outcome.images.length === 2 && pngMagicOk, outcome.note)
			} catch (err) {
				push("page-images", false, (err as Error).message)
			}
		}
	}

	// 4. Hostile-input handling intact in this build.
	try {
		// Deflated 10 MB of zeros — must be rejected by the ratio cap, in < 1 s.
		const zip = new JSZip()
		zip.file("bomb.bin", new Uint8Array(10 * 1024 * 1024))
		const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
		const started = Date.now()
		try {
			await listZipEntries(data)
			push("safety-zip-bomb", false, "bomb not rejected")
		} catch (err) {
			const ok = isDocumentError(err) && err.code === "safety-limit" && Date.now() - started < 1000
			push("safety-zip-bomb", ok, isDocumentError(err) ? err.code : undefined)
		}
	} catch (err) {
		push("safety-zip-bomb", false, (err as Error).message)
	}

	return {
		ok: checks.every((c) => c.ok),
		platform: process.platform,
		arch: process.arch,
		assetSource,
		checks,
	}
}
