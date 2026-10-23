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

describe("pdf.mjs LibreOffice editing (dump-shapes + edit-draw)", () => {
	/** Real fs stubs: runLoDraw's status/output contract crosses real tmpdir.
	 *  The staged export is also mirrored into `files` so the CLI's io.readFile
	 *  (which reads the map) sees what soffice "wrote". */
	function loOverride(outPdfBytes?: Uint8Array, files?: Map<string, Uint8Array>) {
		const { writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs")
		return {
			// Fake soffice discovery too: CI runners have no LibreOffice installed.
			which: (cmd: string) => (cmd === "soffice" ? "/fake/soffice" : undefined),
			run: (_cmd: string, _args: string[], env: Record<string, string>) => {
				writeFileSync(env.LO_STATUS, JSON.stringify({ ok: true, pages: 2, applied: 1 }))
				if (env.LO_MODE === "dump") {
					writeFileSync(
						env.LO_OUT,
						JSON.stringify({
							pages: 2,
							shapes: [{ page: 1, shape: 3, xywh: [10, 20, 200, 30], text: "hello" }],
						}),
					)
				} else if (outPdfBytes !== undefined) {
					writeFileSync(env.LO_OUT, outPdfBytes)
					files?.set(env.LO_OUT, outPdfBytes)
				}
				return { code: 0, stderr: "" }
			},
			rmdir: (dir: string) => rmSync(dir, { recursive: true, force: true }),
		}
	}

	it("dump-shapes prints the shape inventory as JSON", async () => {
		const t = io({ loDraw: loOverride() })
		t.files.set("in.pdf", await makePdf(["hello"]))
		expect(await runPdfCli(["dump-shapes", "in.pdf"], t.io)).toBe(0)
		const dump = JSON.parse(t.out.join(""))
		expect(dump.pages).toBe(2)
		expect(dump.shapes[0]).toMatchObject({ page: 1, shape: 3, text: "hello" })
	})

	it("dump-shapes filters by --page", async () => {
		const t = io({ loDraw: loOverride() })
		t.files.set("in.pdf", await makePdf(["hello"]))
		await runPdfCli(["dump-shapes", "in.pdf", "--page", "2"], t.io)
		const dump = JSON.parse(t.out.join(""))
		expect(dump.shapes).toEqual([])
	})

	it("edit-draw maps shape text and re-verifies the exported PDF", async () => {
		const outBytes = await makePdf(["replaced"])
		const t = io()
		t.io.loDraw = loOverride(outBytes, t.files)
		t.files.set("in.pdf", await makePdf(["hello"]))
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		const mapPath = join(tmpdir(), `pdf-edit-map-${Date.now()}.json`)
		t.files.set(mapPath, new TextEncoder().encode(JSON.stringify([{ page: 1, shape: 3, text: "replaced" }])))
		try {
			const outPath = join(tmpdir(), `pdf-edit-out-${Date.now()}.pdf`)
			t.files.set(outPath, outBytes)
			const code = await runPdfCli(["edit-draw", "in.pdf", "--out", outPath, "--map", mapPath], t.io)
			if (code !== 0) throw new Error(`exit ${code}: ${t.err.join("|")}`)
			expect(t.out.join("")).toContain("1 edit applied of 1 mapped")
		} finally {
			t.files.delete(mapPath)
		}
	})

	it("edit-draw refuses in-place output", async () => {
		const t = io()
		t.files.set("in.pdf", await makePdf(["hello"]))
		expect(await runPdfCli(["edit-draw", "in.pdf", "--out", "in.pdf", "--map", "m.json"], t.io)).toBe(2)
	})

	it("edit-draw rejects an empty map", async () => {
		const t = io()
		t.files.set("in.pdf", await makePdf(["hello"]))
		const { tmpdir } = await import("node:os")
		const { join } = await import("node:path")
		const mapPath = join(tmpdir(), `pdf-edit-map-empty-${Date.now()}.json`)
		t.files.set(mapPath, new TextEncoder().encode("[]"))
		expect(await runPdfCli(["edit-draw", "in.pdf", "--out", "out.pdf", "--map", mapPath], t.io)).toBe(2)
		expect(t.err.join("")).toContain("non-empty JSON array")
	})
})

describe("pdf.mjs render (visual check)", () => {
	/** Fake rasterizer chain: pdftoppm "runs" by writing PNG-named files to the real fs. */
	function rasterizeOverride(opts: { pngs?: string[]; available?: boolean } = {}) {
		const { writeFileSync } = require("node:fs") as typeof import("node:fs")
		const pngs = opts.pngs ?? ["1", "2"]
		return {
			which: (cmd: string) => (cmd === "pdftoppm" && opts.available !== false ? "/fake/pdftoppm" : undefined),
			run: (_cmd: string, args: string[]) => {
				const prefix = args[args.length - 1]
				for (const n of pngs) writeFileSync(`${prefix}-${n}.png`, "png")
				return { code: 0, stdout: "", stderr: "" }
			},
			listdir: (dir: string) => require("node:fs").readdirSync(dir),
		}
	}

	it("writes one PNG per page and names the rasterizer used", async () => {
		const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs")
		const { tmpdir } = await import("node:os")
		const outDir = mkdtempSync(join(await import("node:os").then(() => tmpdir()), "pdf-render-test-"))
		try {
			const t = io({ rasterize: rasterizeOverride() })
			t.files.set("in.pdf", await makePdf(["a", "b"]))
			expect(await runPdfCli(["render", "in.pdf", "--out", outDir], t.io)).toBe(0)
			expect(t.out[0]).toContain("rendered 2 pages of in.pdf")
			expect(t.out[0]).toContain("rasterizer: pdftoppm (poppler)")
			expect(t.out).toHaveLength(3) // summary + 2 image paths
		} finally {
			rmSync(outDir, { recursive: true, force: true })
		}
	})

	it("--pages filters the rendered PNGs", async () => {
		const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs")
		const { tmpdir } = await import("node:os")
		const outDir = mkdtempSync(join(tmpdir(), "pdf-render-test-"))
		try {
			const t = io({ rasterize: rasterizeOverride({ pngs: ["1", "2", "3"] }) })
			t.files.set("in.pdf", await makePdf(["a", "b", "c"]))
			expect(await runPdfCli(["render", "in.pdf", "--out", outDir, "--pages", "2-3"], t.io)).toBe(0)
			expect(t.out[0]).toContain("rendered 2 pages")
			expect(t.out.slice(1).every((p) => /-([23])\.png$/.test(p))).toBe(true)
		} finally {
			rmSync(outDir, { recursive: true, force: true })
		}
	})

	it("is tool-missing with the install hint when no rasterizer exists", async () => {
		const { mkdtempSync, rmSync } = require("node:fs") as typeof import("node:fs")
		const { tmpdir } = await import("node:os")
		const outDir = mkdtempSync(join(tmpdir(), "pdf-render-test-"))
		try {
			const t = io({ rasterize: rasterizeOverride({ available: false }) })
			t.files.set("in.pdf", await makePdf(["a"]))
			expect(await runPdfCli(["render", "in.pdf", "--out", outDir], t.io)).toBe(2)
			expect(t.err.join("")).toContain("tool-missing")
			expect(t.err.join("")).toContain("pdftoppm (poppler-utils), ghostscript, or python3 with pymupdf")
		} finally {
			rmSync(outDir, { recursive: true, force: true })
		}
	})

	it("rejects a bad page range against the real page count", async () => {
		const t = io({ rasterize: rasterizeOverride() })
		t.files.set("in.pdf", await makePdf(["a"]))
		expect(await runPdfCli(["render", "in.pdf", "--out", "some-dir", "--pages", "5-9"], t.io)).toBe(2)
		expect(t.err.join("")).toContain("out of range")
	})
})

describe("pdf.mjs html (styled HTML -> PDF via browser)", () => {
	/** Fake browser: prints a real PDF to the staged --print-to-pdf path and mirrors it into `files`. */
	function browserOverride(pdfBytes?: Uint8Array) {
		const { writeFileSync } = require("node:fs") as typeof import("node:fs")
		return {
			which: (cmd: string) => (cmd === "chromium" ? "/usr/bin/chromium" : undefined),
			fileExists: (p: string) => p !== "/missing",
			run: (_cmd: string, args: string[]) => {
				const target = args.find((a) => a.startsWith("--print-to-pdf="))?.slice("--print-to-pdf=".length)
				if (target && pdfBytes) writeFileSync(target, pdfBytes)
				return { code: 0, stderr: "" }
			},
			env: {},
			platform: "linux" as NodeJS.Platform,
			home: "/home/u",
			mkdtemp: () => "/tmp/fake-profile",
			rmdir: () => undefined,
		}
	}

	it("prints to a staged PDF, verifies, and lands it at --out naming the browser", async () => {
		const printed = await makePdf(["rendered by browser"])
		const t = io({ browser: browserOverride(printed) })
		// The staged output is a real fs path; make readFile see it after the "browser" wrote it.
		const origRead = t.io.readFile!
		t.io.readFile = (path: string) => {
			try {
				return origRead(path)
			} catch {
				return new Uint8Array(require("node:fs").readFileSync(path))
			}
		}
		t.files.set("doc.html", new TextEncoder().encode("<h1>hello</h1>"))
		expect(await runPdfCli(["html", "doc.html", "--out", "out.pdf"], t.io)).toBe(0)
		expect(t.out[0]).toContain("converted doc.html -> out.pdf")
		expect(t.out[0]).toContain("browser: chromium")
		expect(t.written.get("out.pdf")).toBeDefined()
	})

	it("is tool-missing with the install hint and names the core fallback when no browser exists", async () => {
		const t = io({
			browser: {
				which: () => undefined,
				fileExists: () => false,
				run: () => ({ code: 0, stderr: "" }),
				env: {},
				platform: "linux",
				home: "/home/u",
				mkdtemp: () => "/tmp/fake-profile",
				rmdir: () => undefined,
			},
		})
		t.files.set("doc.html", new TextEncoder().encode("<h1>hello</h1>"))
		expect(await runPdfCli(["html", "doc.html", "--out", "out.pdf"], t.io)).toBe(2)
		expect(t.err.join("")).toContain("tool-missing")
		expect(t.err.join("")).toContain("Google Chrome, Chromium, or Microsoft Edge")
		expect(t.err.join("")).toContain("create (plain styling) never needs it")
	})

	it("refuses a non-html input and an --out equal to the input", async () => {
		const t = io({ browser: browserOverride() })
		t.files.set("doc.txt", new TextEncoder().encode("x"))
		expect(await runPdfCli(["html", "doc.txt", "--out", "out.pdf"], t.io)).toBe(2)
		expect(t.err.join("")).toContain("must end in .html")
		t.files.set("doc.html", new TextEncoder().encode("<h1>hello</h1>"))
		expect(await runPdfCli(["html", "doc.html", "--out", "doc.html"], t.io)).toBe(2)
		expect(t.err.join("")).toContain("must differ from the input")
	})
})

describe("pdf.mjs render core (bundled pdfium)", () => {
	const coreOhnePage = () => ({
		loadWasm: async () => new Uint8Array(0),
		initLibrary: async () => ({
			loadDocument: async () => ({
				pages: function* () {
					yield {
						render: async ({
							render,
						}: {
							render: (o: { data: Uint8Array; width: number; height: number }) => Promise<Uint8Array>
						}) => ({
							data: await render({ data: new Uint8Array([200, 50, 50, 255]), width: 1, height: 1 }),
						}),
					}
				},
				destroy: () => {},
			}),
			destroy: () => {},
		}),
	})

	it("labels the route when the bundled pdfium renders", async () => {
		const { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } =
			require("node:fs") as typeof import("node:fs")
		const { tmpdir } = await import("node:os")
		const outDir = mkdtempSync(join(tmpdir(), "pdf-render-core-"))
		try {
			const t = io({ renderCore: coreOhnePage() })
			// renderPdfCore reads its input from the real fs (like the external chain
			// does), so stage it next to the in-memory stub harness.
			writeFileSync("in.pdf", await makePdf(["a"]))
			t.files.set("in.pdf", readFileSync("in.pdf"))
			expect(await runPdfCli(["render", "in.pdf", "--out", outDir], t.io)).toBe(0)
			expect(t.out[0]).toContain("rasterizer: pdfium (bundled)")
			expect(existsSync(join(outDir, "in-1.png"))).toBe(true)
		} finally {
			rmSync("in.pdf", { force: true })
			rmSync(outDir, { recursive: true, force: true })
		}
	})

	it("falls back to external rasterizers with a stderr note when pdfium fails", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
		const { tmpdir } = await import("node:os")
		const outDir = mkdtempSync(join(tmpdir(), "pdf-render-core-"))
		try {
			const t = io({
				renderCore: {
					loadWasm: async () => {
						throw new Error("wasm corrupt")
					},
				},
				rasterize: {
					which: (cmd: string) => (cmd === "pdftoppm" ? "/fake/pdftoppm" : undefined),
					run: (_cmd: string, args: string[]) => {
						const prefix = args[args.length - 1]
						writeFileSync(`${prefix}-1.png`, "png")
						return { code: 0, stdout: "", stderr: "" }
					},
					listdir: (dir: string) => require("node:fs").readdirSync(dir),
				},
			})
			t.files.set("in.pdf", await makePdf(["a"]))
			expect(await runPdfCli(["render", "in.pdf", "--out", outDir], t.io)).toBe(0)
			expect(t.err.join("")).toContain("pdfium unavailable")
			expect(t.out[0]).toContain("rasterizer: pdftoppm (poppler)")
		} finally {
			rmSync(outDir, { recursive: true, force: true })
		}
	})
})
