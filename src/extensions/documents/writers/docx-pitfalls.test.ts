import { describe, expect, it } from "vitest"
import type { Block } from "../markdown/blocks.js"
import { assertImageTypes, enforceDocxPitfalls } from "./docx-pitfalls.js"

const letterContentDxa = 12240 - 2880

describe("docx pitfalls", () => {
	it("rejects ragged tables (rows must match the header width)", () => {
		const table: Block = {
			type: "table",
			header: [[{ text: "A" }], [{ text: "B" }]],
			align: [null, null],
			rows: [[[{ text: "only one" }]]],
		}
		expect(() => enforceDocxPitfalls({ blocks: [table], contentWidthDxa: letterContentDxa })).toThrow(
			/table-rows-must-match-header/,
		)
	})

	it("rejects header-less tables", () => {
		const table: Block = { type: "table", header: [], align: [], rows: [] }
		expect(() => enforceDocxPitfalls({ blocks: [table], contentWidthDxa: letterContentDxa })).toThrow(
			/table-needs-header/,
		)
	})

	it("rejects chart blocks with a named error", () => {
		const chart: Block = { type: "chart", spec: "{}" }
		expect(() => enforceDocxPitfalls({ blocks: [chart], contentWidthDxa: letterContentDxa })).toThrow(
			/chart-not-supported-in-docx/,
		)
	})

	it("rejects unknown image extensions (ImageRun.type is required)", () => {
		const image: Block = { type: "image", href: "vector.foo", alt: "x" }
		expect(() => assertImageTypes({ blocks: [image], contentWidthDxa: letterContentDxa })).toThrow(
			/image-type-must-be-known/,
		)
		const ok: Block = { type: "image", href: "pic.png", alt: "x" }
		expect(() => assertImageTypes({ blocks: [ok], contentWidthDxa: letterContentDxa })).not.toThrow()
	})

	it("accepts a regular table within content width", () => {
		const table: Block = {
			type: "table",
			header: [[{ text: "A" }], [{ text: "B" }]],
			align: [null, null],
			rows: [[[{ text: "1" }], [{ text: "2" }]]],
		}
		expect(() => enforceDocxPitfalls({ blocks: [table], contentWidthDxa: letterContentDxa })).not.toThrow()
	})
})
