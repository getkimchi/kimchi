import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib"
import { describe, expect, it } from "vitest"
import { extractPdf } from "../extractors/pdf.js"
import { fillForm, listFields, mergePdfs, reorderPdf, rotatePdf, splitPdf } from "./pdf.js"

async function makePdf(pages: string[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	for (const text of pages) {
		const page = doc.addPage([400, 300])
		page.drawText(text, { x: 20, y: 260, size: 14, font })
	}
	return new Uint8Array(await doc.save())
}

describe("mergePdfs", () => {
	it("concatenates page counts and order", async () => {
		const a = await makePdf(["AAA"])
		const b = await makePdf(["BBB", "BBB2"])
		const merged = await mergePdfs([a, b])
		const doc = await extractPdf(merged)
		expect(doc.units.map((u) => u.markdown)).toEqual(["AAA", "BBB", "BBB2"])
	})

	it("needs at least two inputs", async () => {
		await expect(mergePdfs([await makePdf(["solo"])])).rejects.toMatchObject({ code: "corrupt" })
	})
})

describe("splitPdf", () => {
	it("extracts the given pages only, order preserved", async () => {
		const data = await makePdf(["p1", "p2", "p3", "p4"])
		const out = await splitPdf(data, [1, 4])
		const doc = await extractPdf(out)
		expect(doc.units.map((u) => u.markdown)).toEqual(["p1", "p4"])
	})

	it("rejects out-of-range pages", async () => {
		const data = await makePdf(["only"])
		await expect(splitPdf(data, [2])).rejects.toMatchObject({ code: "corrupt" })
	})
})

describe("reorderPdf", () => {
	it("applies a full permutation", async () => {
		const data = await makePdf(["first", "second", "third"])
		const out = await reorderPdf(data, [3, 1, 2])
		const doc = await extractPdf(out)
		expect(doc.units.map((u) => u.markdown)).toEqual(["third", "first", "second"])
	})

	it("rejects a partial order (would silently drop pages)", async () => {
		const data = await makePdf(["a", "b"])
		await expect(reorderPdf(data, [2])).rejects.toMatchObject({ code: "corrupt" })
	})

	it("rejects duplicate entries in the order", async () => {
		const data = await makePdf(["a", "b"])
		await expect(reorderPdf(data, [1, 1])).rejects.toMatchObject({ code: "corrupt" })
	})
})

describe("rotatePdf", () => {
	it("rotates the requested page only", async () => {
		const data = await makePdf(["keep", "turn"])
		const out = await rotatePdf(data, { pages: [2], degrees: 90 })
		const doc = await PDFDocument.load(out)
		expect(doc.getPage(0).getRotation().angle % 360).toBe(0)
		expect([90, 270 + 180 + 90, 90 + 360]).toContain(
			doc.getPage(1).getRotation().angle % 360 === 0
				? doc.getPage(1).getRotation().angle + 360
				: doc.getPage(1).getRotation().angle,
		)
	})
})

describe("forms", () => {
	async function makeForm(): Promise<Uint8Array> {
		const doc = await PDFDocument.create()
		const page = doc.addPage([400, 300])
		const font = await doc.embedFont(StandardFonts.Helvetica)
		const form = doc.getForm()
		const name = form.createTextField("user.name")
		name.setText("old")
		name.addToPage(page, { x: 50, y: 200, width: 200, height: 20 })
		const agree = form.createCheckBox("terms.agree")
		agree.addToPage(page, { x: 50, y: 150 })
		const level = form.createDropdown("plan.level")
		level.addOptions(["free", "pro", "team"])
		level.select("free")
		level.addToPage(page, { x: 50, y: 100, width: 100, height: 20 })
		void font
		return new Uint8Array(await doc.save())
	}

	it("lists fields with types, values and options", async () => {
		const fields = await listFields(await makeForm())
		const byName = new Map(fields.map((f) => [f.name, f]))
		expect(byName.get("user.name")).toMatchObject({ type: "text", value: "old" })
		expect(byName.get("terms.agree")).toMatchObject({ type: "checkbox", value: false })
		expect(byName.get("plan.level")).toMatchObject({
			type: "dropdown",
			value: "free",
			options: ["free", "pro", "team"],
		})
	})

	it("fills text, checkbox and dropdown; unknown names are collected, not fatal", async () => {
		const result = await fillForm(await makeForm(), {
			"user.name": "new value",
			"terms.agree": true,
			"plan.level": "pro",
			"no.such.field": "x",
		})
		expect(result.filled).toContain("user.name")
		expect(result.filled).toContain("terms.agree")
		expect(result.filled).toContain("plan.level")
		expect(result.ignored).toHaveLength(1)
		expect(result.ignored[0].name).toBe("no.such.field")
		const fields = await listFields(result.bytes)
		const byName = new Map(fields.map((f) => [f.name, f]))
		expect(byName.get("user.name")).toMatchObject({ value: "new value" })
		expect(byName.get("terms.agree")).toMatchObject({ value: true })
		expect(byName.get("plan.level")).toMatchObject({ value: "pro" })
	})

	it("flags a value that is not among a dropdown's options", async () => {
		const result = await fillForm(await makeForm(), { "plan.level": "enterprise" })
		expect(result.filled).toHaveLength(0)
		expect(result.ignored[0].reason).toContain("free")
	})
})
