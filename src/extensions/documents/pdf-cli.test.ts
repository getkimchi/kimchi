import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib"
import { describe, expect, it } from "vitest"
import { extractPdf } from "./extractors/pdf.js"
import { runPdfCli } from "./pdf-cli.js"

const here = dirname(fileURLToPath(import.meta.url))

function fontBytes() {
	const dir = join(here, "../../..", "node_modules", "dejavu-fonts-ttf", "ttf")
	if (!existsSync(join(dir, "DejaVuSans.ttf"))) throw new Error("dejavu-fonts-ttf not installed in tests")
	return {
		regular: new Uint8Array(readFileSync(join(dir, "DejaVuSans.ttf"))),
		bold: new Uint8Array(readFileSync(join(dir, "DejaVuSans-Bold.ttf"))),
		mono: new Uint8Array(readFileSync(join(dir, "DejaVuSansMono.ttf"))),
	}
}

async function makePdf(pages: string[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	for (const text of pages) {
		const page = doc.addPage([400, 300])
		page.drawText(text, { x: 20, y: 260, size: 14, font })
	}
	return new Uint8Array(await doc.save())
}

async function makeForm(): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const page = doc.addPage([400, 300])
	const form = doc.getForm()
	const name = form.createTextField("user.name")
	name.setText("old")
	name.addToPage(page, { x: 50, y: 200, width: 200, height: 20 })
	return new Uint8Array(await doc.save())
}

function io(overrides: Partial<Parameters<typeof runPdfCli>[1]> = {}) {
	const out: string[] = []
	const err: string[] = []
	const files = new Map<string, Uint8Array>()
	const written = new Map<string, Uint8Array>()
	return {
		out,
		err,
		files,
		written,
		io: {
			stdout: (line: string) => out.push(line),
			stderr: (line: string) => err.push(line),
			fonts: fontBytes(),
			readFile: (path: string) => {
				const data = files.get(path)
				if (!data) throw new Error(`ENOENT: ${path}`)
				return data
			},
			writeFile: (path: string, data: Uint8Array) => {
				written.set(path, data)
			},
			...overrides,
		},
	}
}

describe("pdf.mjs read", () => {
	it("renders pages as markdown with Page N units", async () => {
		const t = io()
		t.files.set("doc.pdf", await makePdf(["hello world"]))
		expect(await runPdfCli(["read", "doc.pdf"], t.io)).toBe(0)
		expect(t.out.join("\n")).toContain("Page 1")
		expect(t.out.join("\n")).toContain("hello world")
	})

	it("rejects a missing file with typed error and exit 2", async () => {
		const t = io()
		expect(await runPdfCli(["read", "missing.pdf"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("error [corrupt]: Cannot read missing.pdf")
	})

	it("rejects over-cap files as too-large", async () => {
		const t = io()
		process.env.KIMCHI_DOCUMENT_MAX_MB = "1"
		try {
			t.files.set("big.pdf", new Uint8Array(1_500_000).fill(0x25))
			expect(await runPdfCli(["read", "big.pdf"], t.io)).toBe(2)
			expect(t.err.join("\n")).toContain("error [too-large]")
		} finally {
			delete process.env.KIMCHI_DOCUMENT_MAX_MB
		}
	})

	it("offers a continuation hint for long documents", async () => {
		const t = io()
		const pages = Array.from({ length: 25 }, (_, i) => `page ${i + 1}`)
		t.files.set("long.pdf", await makePdf(pages))
		expect(await runPdfCli(["read", "long.pdf"], t.io)).toBe(0)
		expect(t.err.join("\n")).toContain("read long.pdf 21-40")
		expect(t.out.join("\n")).toContain("Page 20")
	})

	it("reports scanned PDFs as extraction-failed", async () => {
		const t = io()
		const doc = await PDFDocument.create()
		doc.addPage([200, 100])
		t.files.set("scan.pdf", new Uint8Array(await doc.save()))
		expect(await runPdfCli(["read", "scan.pdf"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("error [extraction-failed]")
	})
})

describe("pdf.mjs info", () => {
	it("reports page count as JSON", async () => {
		const t = io()
		t.files.set("doc.pdf", await makePdf(["a", "b"]))
		expect(await runPdfCli(["info", "doc.pdf"], t.io)).toBe(0)
		expect(JSON.parse(t.out[0])).toEqual({ pageCount: 2, encrypted: false })
	})
})

describe("pdf.mjs fields + fill-form", () => {
	it("lists fields", async () => {
		const t = io()
		t.files.set("form.pdf", await makeForm())
		expect(await runPdfCli(["fields", "form.pdf"], t.io)).toBe(0)
		expect(JSON.parse(t.out[0])).toMatchObject({ name: "user.name", type: "text", value: "old" })
	})

	it("fills values end-to-end and refuses in-place output", async () => {
		const t = io()
		t.files.set("form.pdf", await makeForm())
		t.files.set("values.json", new TextEncoder().encode(JSON.stringify({ "user.name": "filled" })))
		expect(await runPdfCli(["fill-form", "form.pdf", "--out", "form.pdf", "--values", "values.json"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("--out must differ")
		expect(await runPdfCli(["fill-form", "form.pdf", "--out", "filled.pdf", "--values", "values.json"], t.io)).toBe(0)
		const filled = t.written.get("filled.pdf")
		if (filled === undefined) throw new Error("filled.pdf was not written")
		const { listFields } = await import("./editors/pdf.js")
		const fields = await listFields(filled)
		expect(fields[0]).toMatchObject({ name: "user.name", value: "filled" })
	})
})

describe("pdf.mjs create", () => {
	it("creates a document that read() can extract", async () => {
		const t = io()
		t.files.set(
			"doc.md",
			new TextEncoder().encode(
				`# Report\n\nTotal **cost** went up.\n\n- alpha\n- beta\n\n| Item | N |\n|---|---|\n| x | 1 |`,
			),
		)
		expect(await runPdfCli(["create", "out.pdf", "--content", "doc.md"], t.io)).toBe(0)
		const bytes = t.written.get("out.pdf")
		if (bytes === undefined) throw new Error("out.pdf was not written")
		const doc = await extractPdf(bytes)
		const text = doc.units.map((u) => u.markdown).join("\n")
		expect(text).toContain("Report")
		expect(text).toContain("cost")
		expect(text).toContain("alpha")
		// input untouched
		expect(t.written.size).toBe(1)
	})

	it("rejects a non-pdf output path", async () => {
		const t = io()
		t.files.set("doc.md", new TextEncoder().encode("# hi"))
		expect(await runPdfCli(["create", "out.docx", "--content", "doc.md"], t.io)).toBe(2)
		expect(t.err.join("\n")).toContain("must end in .pdf")
	})
})

describe("pdf.mjs structural edits", () => {
	it("merge concatenates two inputs", async () => {
		const t = io()
		t.files.set("a.pdf", await makePdf(["AAA"]))
		t.files.set("b.pdf", await makePdf(["BBB"]))
		expect(await runPdfCli(["merge", "out.pdf", "a.pdf", "b.pdf"], t.io)).toBe(0)
		const merged = t.written.get("out.pdf")
		if (merged === undefined) throw new Error("out.pdf was not written")
		const doc = await extractPdf(merged)
		expect(doc.units.map((u) => u.markdown)).toEqual(["AAA", "BBB"])
	})

	it("merge refuses output equal to an input", async () => {
		const t = io()
		t.files.set("a.pdf", await makePdf(["AAA"]))
		t.files.set("b.pdf", await makePdf(["BBB"]))
		expect(await runPdfCli(["merge", "a.pdf", "a.pdf", "b.pdf"], t.io)).toBe(2)
	})

	it("split extracts a page range", async () => {
		const t = io()
		t.files.set("in.pdf", await makePdf(["p1", "p2", "p3"]))
		expect(await runPdfCli(["split", "in.pdf", "--pages", "2-3", "--out", "part.pdf"], t.io)).toBe(0)
		const part = t.written.get("part.pdf")
		if (part === undefined) throw new Error("part.pdf was not written")
		const doc = await extractPdf(part)
		expect(doc.units.map((u) => u.markdown)).toEqual(["p2", "p3"])
	})

	it("reorder applies a permutation and flags a bad one", async () => {
		const t = io()
		t.files.set("in.pdf", await makePdf(["one", "two", "three"]))
		expect(await runPdfCli(["reorder", "in.pdf", "--order", "3,1,2", "--out", "re.pdf"], t.io)).toBe(0)
		const re = t.written.get("re.pdf")
		if (re === undefined) throw new Error("re.pdf was not written")
		const doc = await extractPdf(re)
		expect(doc.units.map((u) => u.markdown)).toEqual(["three", "one", "two"])
		expect(await runPdfCli(["reorder", "in.pdf", "--order", "1,1,2", "--out", "bad.pdf"], t.io)).toBe(2)
		expect(t.written.get("bad.pdf")).toBeUndefined()
	})

	it("rotate errors on a bad angle without writing", async () => {
		const t = io()
		t.files.set("in.pdf", await makePdf(["page"]))
		expect(await runPdfCli(["rotate", "in.pdf", "--out", "r.pdf", "--angle", "45"], t.io)).toBe(2)
		expect(t.written.get("r.pdf")).toBeUndefined()
	})
})
