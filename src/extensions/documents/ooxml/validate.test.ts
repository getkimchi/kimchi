import { describe, expect, it } from "vitest"
import { validateChartAxisIds, validateContentTypes, validatePresentationChildOrder } from "./validate.js"
import { parseXml } from "./xml.js"

describe("validateContentTypes", () => {
	const typesWith = (overrides: string[], defaults: string[]) =>
		parseXml(
			`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${overrides
				.map((p) => `<Override PartName="/${p}" ContentType="x"/>`)
				.join("")}${defaults.map((e) => `<Default Extension="${e}" ContentType="x"/>`).join("")}</Types>`,
		)

	it("passes when every part is covered by Override or Default", () => {
		const problems = validateContentTypes(
			{ names: () => ["[Content_Types].xml", "doc.xml", "pic.png"] },
			typesWith(["doc.xml"], ["png"]),
		)
		expect(problems).toEqual([])
	})

	it("flags parts with no coverage", () => {
		const problems = validateContentTypes({ names: () => ["odd.bin"] }, typesWith([], []))
		expect(problems[0]).toMatch(/odd\.bin/)
	})

	it("flags a missing [Content_Types].xml", () => {
		expect(validateContentTypes({ names: () => ["a.xml"] }, undefined)).toEqual(["missing [Content_Types].xml"])
	})
})

describe("validatePresentationChildOrder", () => {
	it("passes in-order children", () => {
		const doc = parseXml(
			`<p:presentation xmlns:p="urn:x"><p:sldMasterIdLst/><p:sldIdLst/><p:sldSz/><p:notesSz/></p:presentation>`,
		)
		expect(validatePresentationChildOrder(doc)).toEqual([])
	})
	it("flags out-of-order children", () => {
		const doc = parseXml(`<p:presentation xmlns:p="urn:x"><p:sldSz/><p:sldIdLst/></p:presentation>`)
		expect(validatePresentationChildOrder(doc)[0]).toMatch(/out of schema order/)
	})
	it("ignores non-presentation roots", () => {
		expect(validatePresentationChildOrder(parseXml(`<other/>`))).toEqual([])
	})
})

describe("validateChartAxisIds", () => {
	const chart = (inner: string) =>
		parseXml(`<c:chartSpace xmlns:c="urn:x"><c:chart><c:plotArea>${inner}</c:plotArea></c:chart></c:chartSpace>`)
	it("passes with matching declaration and reference", () => {
		const doc = chart(`<c:barChart><c:axId val="111"/></c:barChart><c:catAx><c:axId val="111"/></c:catAx>`)
		expect(validateChartAxisIds(doc)).toEqual([])
	})
	it("flags a referenced id with no declared axis", () => {
		const doc = chart(`<c:barChart><c:axId val="999"/></c:barChart><c:catAx><c:axId val="111"/></c:catAx>`)
		expect(validateChartAxisIds(doc)[0]).toMatch(/999/)
	})
})
