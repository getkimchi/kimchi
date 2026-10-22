import { describe, expect, it } from "vitest"
import { makeSimpleXlsx } from "./fixtures/builders.js"
import { runXlsxCli, type CliIo } from "./xlsx-cli.js"

function testIo(files: Record<string, Uint8Array> = {}) {
	const out: string[] = []
	const err: string[] = []
	const written: Record<string, Uint8Array> = {}
	const io: CliIo = {
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		readFile: (path) => {
			const f = files[path]
			if (!f) throw new Error(`no test file ${path}`)
			return f
		},
		writeFile: (path, data) => {
			written[path] = data
		},
	}
	return { io, out, err, written }
}

describe("runXlsxCli read", () => {
	it("renders the first sheet as a Markdown table with row numbers", async () => {
		const { io, out, err } = testIo({ "a.xlsx": await makeSimpleXlsx() })
		expect(await runXlsxCli(["read", "a.xlsx"], io)).toBe(0)
		expect(out[0]).toContain("# a.xlsx — sheet \"Data\" rows 1-3")
		expect(out[0]).toContain("| 1 | padding cell | 2.5 | 2024-01-01 | 0 |")
		expect(err[0]).toContain("hidden sheets: Scratch")
	})

	it("honors --sheet by name, --start-row/--end-row and --show-formulas", async () => {
		const { io, out } = testIo({ "a.xlsx": await makeSimpleXlsx() })
		expect(await runXlsxCli(["read", "a.xlsx", "--sheet", "Scratch"], io)).toBe(0)
		expect(out[0]).toContain('sheet "Scratch"')
		const { io: io2, out: out2 } = testIo({ "a.xlsx": await makeSimpleXlsx() })
		expect(await runXlsxCli(["read", "a.xlsx", "--start-row", "2", "--end-row", "3", "--show-formulas"], io2)).toBe(0)
		expect(out2[0]).toContain("rows 2-3")
		expect(out2[0]).toContain("=SUM(B1:B2)")
	})

	it("reads csv text into the same table shape", async () => {
		const { io, out } = testIo({ "a.csv": new TextEncoder().encode("x,y\n1,2\n") })
		expect(await runXlsxCli(["read", "a.csv"], io)).toBe(0)
		expect(out[0]).toContain('sheet "(csv)"')
		expect(out[0]).toContain("| 1 | x | y |")
	})

	it("rejects unknown flags and missing files with the standard shape", async () => {
		const { io, err } = testIo({ "a.xlsx": await makeSimpleXlsx() })
		expect(await runXlsxCli(["read", "a.xlsx", "--bogus"], io)).toBe(2)
		expect(err[0]).toContain("error [corrupt]: unknown flag --bogus")
		const { io: io2, err: err2 } = testIo()
		expect(await runXlsxCli(["read", "missing.xlsx"], io2)).toBe(2)
		expect(err2[0]).toContain("error [corrupt]: Cannot read missing.xlsx")
	})
})

describe("runXlsxCli info", () => {
	it("lists sheets with hidden state and dimensions", async () => {
		const { io, out } = testIo({ "a.xlsx": await makeSimpleXlsx() })
		expect(await runXlsxCli(["info", "a.xlsx"], io)).toBe(0)
		expect(out[0]).toContain('sheet 1: "Data" — 3 rows × D columns')
		expect(out[0]).toContain('sheet 2: "Scratch" (hidden) — 1 rows × A columns')
	})
})

describe("runXlsxCli create", () => {
	it("builds a workbook from a spec, no in-place, placeholder summary", async () => {
		const spec = {
			sheets: [
				{
					name: "Data",
					freezeHeader: true,
					rows: [
						[{ v: "H", bold: true }],
						["lorem ipsum", { f: "A1:A1".replace("A1:A1", "SUM(A1:A1)") }],
					],
				},
			],
		}
		const files = { "spec.json": new TextEncoder().encode(JSON.stringify(spec)) }
		const { io, out, err, written } = testIo(files)
		expect(await runXlsxCli(["create", "spec.json", "--out", "out.xlsx"], io)).toBe(0)
		expect(written["out.xlsx"]).toBeDefined()
		expect(out[0]).toContain("created out.xlsx (1 sheet(s), 1 formula(s))")
		void err
	})

	it("rejects --out == --spec, non-xlsx outputs and unknown flags", async () => {
		const { io, err } = testIo({ "spec.json": new TextEncoder().encode("{}") })
		expect(await runXlsxCli(["create", "spec.json", "--out", "spec.json"], io)).toBe(2)
		expect(err[0]).toContain("--out must differ from the spec")
		const { io: io2, err: err2 } = testIo({ "spec.json": new TextEncoder().encode("{}") })
		expect(await runXlsxCli(["create", "spec.json", "--out", "out.csv"], io2)).toBe(2)
		expect(err2[0]).toContain("output path must end in .xlsx")
		const { io: io3, err: err3 } = testIo({ "spec.json": new TextEncoder().encode("{}") })
		expect(await runXlsxCli(["create", "spec.json", "--out", "out.xlsx", "--spec-x"], io3)).toBe(2)
		expect(err3[0]).toContain("unknown flag --spec-x")
	})

	it("refuses a spec with no sheets", async () => {
		const { io, err } = testIo({ "spec.json": new TextEncoder().encode(JSON.stringify({ sheets: [] })) })
		expect(await runXlsxCli(["create", "spec.json", "--out", "o.xlsx"], io)).toBe(2)
		expect(err[0]).toContain("at least one sheet")
	})
})
