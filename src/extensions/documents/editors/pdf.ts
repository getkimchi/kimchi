/**
 * PDF structural edits for pdf.mjs — merge, split (page extract), reorder,
 * rotate, and AcroForm inspection/fill — on @cantoo/pdf-lib. All functions
 * take input bytes and return new bytes; they never mutate the input.
 *
 * Page numbers are 1-based, matching the [Page N] locators from `read`.
 * Encrypted inputs are a typed error — pdf-lib can't open them, and the
 * skill must not pretend it can.
 */

import {
	degrees,
	PDFCheckBox,
	PDFDocument,
	PDFDropdown,
	PDFOptionList,
	PDFRadioGroup,
	PDFTextField,
} from "@cantoo/pdf-lib"
import { DocumentError } from "../model.js"

type Value = string | boolean | readonly string[]

export interface PdfFormField {
	name: string
	type: "text" | "checkbox" | "dropdown" | "option-list" | "radio-group" | "signature" | "unknown"
	value?: string | boolean | string[]
	options?: string[]
}

async function loadPdf(data: Uint8Array): Promise<PDFDocument> {
	let doc: PDFDocument
	try {
		doc = await PDFDocument.load(data, { ignoreEncryption: true })
	} catch (err) {
		throw new DocumentError("corrupt", `PDF failed to parse: ${(err as Error).message ?? err}`, "pdf")
	}
	if (doc.isEncrypted) {
		throw new DocumentError("password-protected", "PDF is password-protected; ask for a decrypted copy", "pdf")
	}
	return doc
}

function assertPages(doc: PDFDocument, pages: readonly number[]): void {
	const total = doc.getPageCount()
	for (const p of pages) {
		if (p < 1 || p > total) {
			throw new DocumentError(
				"corrupt",
				`page ${p} out of range — the document has ${total} page${total === 1 ? "" : "s"}`,
				"pdf",
			)
		}
	}
	for (const p of pages) {
		if (!Number.isInteger(p)) throw new DocumentError("corrupt", `page ${p} is not an integer`, "pdf")
	}
}

/** Merge PDFs in the given order into one document. */
export async function mergePdfs(inputs: readonly Uint8Array[]): Promise<Uint8Array> {
	if (inputs.length < 2) throw new DocumentError("corrupt", "merge needs at least two input files", "pdf")
	const out = await PDFDocument.create()
	for (const [i, data] of inputs.entries()) {
		const src = await loadPdf(data)
		const pages = await out.copyPages(src, src.getPageIndices())
		for (const page of pages) out.addPage(page)
		void i
	}
	return new Uint8Array(await out.save())
}

/** Extract the given 1-based pages into a new document, preserving order. */
export async function splitPdf(data: Uint8Array, pages: readonly number[]): Promise<Uint8Array> {
	if (pages.length === 0) throw new DocumentError("corrupt", "split needs at least one page", "pdf")
	const src = await loadPdf(data)
	assertPages(src, pages)
	const out = await PDFDocument.create()
	const copied = await out.copyPages(
		src,
		pages.map((p) => p - 1),
	)
	for (const page of copied) out.addPage(page)
	return new Uint8Array(await out.save())
}

/**
 * Rebuild the document from `order` — a 1-based permutation of every page.
 * Rejects non-permutations so a typo can't silently drop pages.
 */
export async function reorderPdf(data: Uint8Array, order: readonly number[]): Promise<Uint8Array> {
	const src = await loadPdf(data)
	const total = src.getPageCount()
	if (order.length !== total) {
		throw new DocumentError("corrupt", `order must list all ${total} pages, got ${order.length}`, "pdf")
	}
	assertPages(src, order)
	if (new Set(order).size !== total) {
		throw new DocumentError("corrupt", `order (${order.join(",")}) has duplicates — it must be a permutation`, "pdf")
	}
	const out = await PDFDocument.create()
	const copied = await out.copyPages(
		src,
		order.map((p) => p - 1),
	)
	for (const page of copied) out.addPage(page)
	return new Uint8Array(await out.save())
}

/** Rotate the given 1-based pages by 90/180/270 degrees (absolute or additive). */
export async function rotatePdf(
	data: Uint8Array,
	options: { pages?: readonly number[]; degrees: 90 | 180 | 270 },
): Promise<Uint8Array> {
	const doc = await loadPdf(data)
	const pages = options.pages ?? doc.getPageIndices().map((i) => i + 1)
	assertPages(doc, pages)
	for (const p of pages) {
		const page = doc.getPage(p - 1)
		const next = (page.getRotation().angle + options.degrees) % 360
		page.setRotation(degrees((next + 360) % 360))
	}
	return new Uint8Array(await doc.save())
}

function fieldType(field: unknown): PdfFormField["type"] {
	if (field instanceof PDFTextField) return "text"
	if (field instanceof PDFCheckBox) return "checkbox"
	if (field instanceof PDFDropdown) return "dropdown"
	if (field instanceof PDFOptionList) return "option-list"
	if (field instanceof PDFRadioGroup) return "radio-group"
	if (typeof field === "object" && field !== null && field.constructor.name === "PDFSignature") return "signature"
	return "unknown"
}

/** List AcroForm fields with current values and, for selectors, options. */
export async function listFields(data: Uint8Array): Promise<PdfFormField[]> {
	const doc = await loadPdf(data)
	const form = doc.getForm()
	return form.getFields().map((field) => {
		const type = fieldType(field)
		const out: PdfFormField = { name: field.getName(), type }
		try {
			if (field instanceof PDFTextField) out.value = field.getText() ?? ""
			else if (field instanceof PDFCheckBox) out.value = field.isChecked()
			else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
				// getSelected() returns string[] for these controls; a single
				// selection reads better as a scalar.
				const sel = field.getSelected()
				out.value = sel.length > 1 ? sel : (sel[0] ?? "")
				out.options = field.getOptions()
			} else if (field instanceof PDFRadioGroup) {
				out.value = field.getSelected()
				out.options = field.getOptions()
			}
		} catch {
			// A field that can't report its state is still listed — type only.
		}
		return out
	})
}

/**
 * Fill AcroForm fields from a name→value map. Unknown names and type
 * mismatches are collected into `ignored` (with a reason) instead of
 * aborting, so one typo doesn't undo a 20-field form.
 */
export async function fillForm(
	data: Uint8Array,
	values: Record<string, Value>,
): Promise<{ bytes: Uint8Array; filled: string[]; ignored: Array<{ name: string; reason: string }> }> {
	const doc = await loadPdf(data)
	const form = doc.getForm()
	const byName = new Map(form.getFields().map((f) => [f.getName(), f]))
	const filled: string[] = []
	const ignored: Array<{ name: string; reason: string }> = []
	for (const [name, value] of Object.entries(values)) {
		const field = byName.get(name)
		if (!field) {
			ignored.push({ name, reason: `no such field (have: ${[...byName.keys()].join(", ") || "none"})` })
			continue
		}
		try {
			if (field instanceof PDFTextField) {
				if (typeof value !== "string") throw new Error("needs a string value")
				field.setText(value)
			} else if (field instanceof PDFCheckBox) {
				if (typeof value !== "boolean") throw new Error("needs a boolean value")
				if (value) field.check()
				else field.uncheck()
			} else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
				const options = field.getOptions()
				const pick =
					typeof value === "string" ? value : Array.isArray(value) ? (value[0] as string | undefined) : undefined
				if (pick === undefined || !options.includes(pick)) {
					throw new Error(`needs one of ${JSON.stringify(options)}`)
				}
				field.select(pick)
			} else {
				throw new Error("unsupported field type")
			}
			// Appearance refresh is best-effort cosmetics: some widgets throw
			// without a default /DA. The VALUE is already set — still count the
			// field as filled so one cosmetic failure can't hide a write.
			try {
				// The field union's call signatures intersect on a required PDFFont
				// param that no branch actually needs; every member accepts
				// undefined at runtime.
				;(field as { updateAppearances(font?: undefined): void }).updateAppearances()
			} catch {
				// ignore -- value was set above
			}
			filled.push(name)
		} catch (err) {
			ignored.push({ name, reason: (err as Error).message ?? String(err) })
		}
	}
	if (filled.length === 0 && Object.keys(values).length === 0) {
		throw new DocumentError("corrupt", "fill-form needs at least one name→value pair (see `fields` output)", "pdf")
	}
	return { bytes: new Uint8Array(await doc.save()), filled, ignored }
}
