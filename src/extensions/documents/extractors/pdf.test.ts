import { describe, expect, it } from "vitest"
import { extractDocument } from "../extract.js"
import { makePdfWithBlankPage, makeSimplePdf } from "../fixtures/builders.js"
import { DocumentError } from "../model.js"
import { __testables } from "./pdf.js"

describe("extractDocument(pdf)", () => {
	it("extracts per-page text with stable labels and outline", async () => {
		const doc = await extractDocument("report.pdf", await makeSimplePdf())
		expect(doc.format).toBe("pdf")
		expect(doc.unitKind).toBe("page")
		expect(doc.units).toHaveLength(2)
		expect(doc.units[0].label).toBe("Page 1")
		expect(doc.units[0].markdown).toContain("Hello from page one")
		expect(doc.units[1].markdown).toContain("Second page content")
		expect(doc.outline[0]).toMatch(/^Page 1: Hello from page one/)
	})

	it("notes pages without a text layer", async () => {
		const doc = await extractDocument("blank.pdf", await makePdfWithBlankPage())
		expect(doc.notes).toContain("page 1 has no text layer")
		expect(doc.units[1].markdown).toContain("Only this page has text")
	})

	it("maps a non-PDF stream to a typed corrupt error", async () => {
		await expect(extractDocument("bad.pdf", new TextEncoder().encode("%PDF- totally broken"))).rejects.toMatchObject({
			name: "DocumentError",
			code: "corrupt",
		})
	})
})

describe("translatePdfError", () => {
	it("maps PasswordException", () => {
		const err = __testables.translatePdfError({ name: "PasswordException", message: "need pw" })
		expect(err).toBeInstanceOf(DocumentError)
		expect(err.code).toBe("password-protected")
	})
	it("maps AbortException to timeout", () => {
		expect(__testables.translatePdfError({ name: "AbortException", message: "Aborted" }).code).toBe("timeout")
	})
})
