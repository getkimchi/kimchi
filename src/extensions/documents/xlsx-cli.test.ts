import { describe, expect, it } from "vitest"
import { makeCustomXlsx, makeOfficeShapedXlsx, makeSimpleXlsx } from "./fixtures/builders.js"
import { type CliIo, runXlsxCli } from "./xlsx-cli.js"

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
		expect(out[0]).toContain('# a.xlsx — sheet "Data" rows 1-3')
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

	it("reports malformed XML as a typed corrupt error (exit 2, no stack trace)", async () => {
		const bad = await makeCustomXlsx([
			{ name: "S", inner: `<sheetData><row r="1"><c r="A1"><v>1</v></row></sheetData>` },
		])
		const { io, err } = testIo({ "bad.xlsx": bad })
		expect(await runXlsxCli(["read", "bad.xlsx"], io)).toBe(2)
		expect(err[0]).toContain("error [corrupt]:")
	})

	it("reads an Excel 2010+ shaped workbook (x14ac namespaces) end to end", async () => {
		const { io, out, err } = testIo({ "o.xlsx": await makeOfficeShapedXlsx() })
		expect(await runXlsxCli(["read", "o.xlsx"], io)).toBe(0)
		expect(err[0] ?? "").not.toContain("Error")
		expect(out[0]).toContain("2023-01-01")
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
					rows: [[{ v: "H", bold: true }], ["lorem ipsum", { f: "A1:A1".replace("A1:A1", "SUM(A1:A1)") }]],
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

describe("runXlsxCli edit", () => {
	it("applies ops to a fresh output with a per-op summary", async () => {
		const ops = [
			{ kind: "set-cells", cells: { B1: 10 } },
			{ kind: "append-rows", rows: [["tail", { f: "B1*2" }]] },
		]
		const files = {
			"in.xlsx": await makeSimpleXlsx(),
			"ops.json": new TextEncoder().encode(JSON.stringify(ops)),
		}
		const { io, out, written } = testIo(files)
		expect(await runXlsxCli(["edit", "in.xlsx", "--out", "out.xlsx", "--ops", "ops.json"], io)).toBe(0)
		expect(written["out.xlsx"]).toBeDefined()
		expect(out[0]).toContain("edited in.xlsx -> out.xlsx (2 ops applied)")
		expect(out[0]).toContain("op 1 set-cells")
		expect(out[0]).toContain("op 2 append-rows")
		expect(out[0]).toContain("recalculates on open")
	})

	it("rejects in-place edits, unknown flags and bad ops", async () => {
		const { io, err } = testIo({ "in.xlsx": await makeSimpleXlsx(), "ops.json": new TextEncoder().encode("[]") })
		expect(await runXlsxCli(["edit", "in.xlsx", "--out", "in.xlsx", "--ops", "ops.json"], io)).toBe(2)
		expect(err[0]).toContain("--out must differ from the input")
		const { io: io2, err: err2 } = testIo({
			"in.xlsx": await makeSimpleXlsx(),
			"ops.json": new TextEncoder().encode("[]"),
		})
		expect(await runXlsxCli(["edit", "in.xlsx", "--out", "o.xlsx", "--ops", "ops.json", "--wat"], io2)).toBe(2)
		expect(err2[0]).toContain("unknown flag --wat")
		const { io: io3, err: err3 } = testIo({
			"in.xlsx": await makeSimpleXlsx(),
			"ops.json": new TextEncoder().encode(JSON.stringify([{ kind: "nope" }])),
		})
		expect(await runXlsxCli(["edit", "in.xlsx", "--out", "o.xlsx", "--ops", "ops.json"], io3)).toBe(2)
		expect(err3[0]).toContain("unknown kind")
		const { io: io4, err: err4 } = testIo({
			"in.xlsx": await makeSimpleXlsx(),
			"ops.json": new TextEncoder().encode("[]"),
		})
		expect(await runXlsxCli(["edit", "in.xlsx", "--out", "o.xlsx", "--ops", "ops.json"], io4)).toBe(2)
		expect(err4[0]).toContain("ops array is empty")
	})
})

describe("typed errors and new commands", () => {
	it("rejects .xls and OLE2 containers with unsupported-format and a hint", async () => {
		const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4])
		const { io, err } = testIo({ "book.xls": ole })
		expect(await runXlsxCli(["read", "book.xls"], io)).toBe(2)
		expect(err[0]).toContain("error [unsupported-format]")
		expect(err[0]).toContain("soffice --convert-to")
		const { io: io2, err: err2 } = testIo({ "weird.xlsx": ole })
		expect(await runXlsxCli(["read", "weird.xlsx"], io2)).toBe(2)
		expect(err2[0]).toContain("encrypted workbook")
	})

	it("writes no output when a touched part is malformed (gate, exit 2)", async () => {
		// The input sheet already holds a malformed row; editing another row of
		// that SHEET touches the part, so the gate parses every row and fails.
		const bad = await makeCustomXlsx([
			{
				name: "S",
				inner: `<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><zz:c/></row></sheetData>`,
			},
		])
		const ops = new TextEncoder().encode(JSON.stringify([{ kind: "set-cells", cells: { A1: 9 } }]))
		const { io, err, written } = testIo({ "in.xlsx": bad, "ops.json": ops })
		expect(await runXlsxCli(["edit", "in.xlsx", "--out", "out.xlsx", "--ops", "ops.json"], io)).toBe(2)
		expect(err[0]).toContain("error [corrupt]")
		expect(err[0]).toContain("malformed XML")
		expect(written["out.xlsx"]).toBeUndefined()
	})

	it("caps oversized ops files before parsing", async () => {
		// Valid JSON, ~1.5 MB — over a 1 MB cap, under the default.
		const huge = new TextEncoder().encode(JSON.stringify([{ kind: "set-cells", cells: { A1: "x".repeat(1_500_000) } }]))
		const { io, err } = testIo({ "in.xlsx": await makeSimpleXlsx(), "ops.json": huge })
		const prev = process.env.KIMCHI_DOCUMENT_MAX_MB
		try {
			process.env.KIMCHI_DOCUMENT_MAX_MB = "1"
			expect(await runXlsxCli(["edit", "in.xlsx", "--out", "o.xlsx", "--ops", "ops.json"], io)).toBe(2)
			expect(err[0]).toContain("too-large")
		} finally {
			if (prev === undefined) delete process.env.KIMCHI_DOCUMENT_MAX_MB
			else process.env.KIMCHI_DOCUMENT_MAX_MB = prev
		}
	})

	it("recalc degrades to tool-missing without LibreOffice", async () => {
		const { io, err } = testIo({ "in.xlsx": await makeSimpleXlsx() })
		const prev = process.env.KIMCHI_SOFFICE
		try {
			process.env.KIMCHI_SOFFICE = "/nonexistent/soffice"
			expect(await runXlsxCli(["recalc", "in.xlsx", "--out", "o.xlsx"], io)).toBe(2)
			expect(err[0]).toContain("error [tool-missing]")
		} finally {
			if (prev === undefined) delete process.env.KIMCHI_SOFFICE
			else process.env.KIMCHI_SOFFICE = prev
		}
	})

	it("recalc refuses .xlsm up front (LibreOffice drops macros)", async () => {
		const { io, err } = testIo({ "m.xlsm": await makeSimpleXlsx() })
		expect(await runXlsxCli(["recalc", "m.xlsm", "--out", "o.xlsx"], io)).toBe(2)
		expect(err[0]).toContain("recalc of .xlsm loses macros")
	})
})
